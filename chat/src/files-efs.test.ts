import { createHmac } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryDocuments } from '../test/memory-documents.js';
import { AccountResources } from './account-resources.js';
import { accountFilesEfs, signFilesLink, type AccessPoints } from './files-efs.js';

const ACCOUNT = 'acct_0123456789';
/** `printf acct_0123456789 | shasum -a 256`, first 32 hex digits. */
const HASH = '8300e9d12ce55ca979c3e7e01a8f7fac';
const FILE_SYSTEM_ARN = 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-0abc';
const LINKS = { url: 'https://links.test/', key: 'k'.repeat(64) };
const NOW = Date.UTC(2026, 10, 6, 5);

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'files-efs-'));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function fakeAccessPoints() {
  const live = new Map<string, string>();
  const created: string[] = [];
  const points: AccessPoints = {
    async create(directory, token) {
      const arn = `${FILE_SYSTEM_ARN.replace('file-system/fs-0abc', 'access-point')}/fsap-${token.slice(0, 8)}`;
      live.set(arn, directory); created.push(directory); return arn;
    },
    async delete(arn) { return live.delete(arn); },
  };
  return { live, created, points };
}

function setup() {
  const records = new AccountResources('chat', memoryDocuments());
  const access = fakeAccessPoints();
  const minted: string[] = [];
  const files = accountFilesEfs({
    root, mountTargetIp: '192.0.2.12', fileSystemArn: FILE_SYSTEM_ARN, accessPoints: access.points, records: () => records, links: LINKS,
    mountCredentials: async (accessPointArn) => {
      minted.push(accessPointArn);
      return { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token', expiration: new Date(Date.now() + 3_600_000).toISOString() };
    },
  });
  return { files, records, access, minted };
}

const put = async (account: string, name: string, body = 'x') => {
  const file = path.join(root, account, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
};
const snapshot = async (folder: string) => Object.fromEntries(await Promise.all(
  (await readdir(folder, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile())
    .map(async (entry) => [path.join(entry.parentPath, entry.name), await readFile(path.join(entry.parentPath, entry.name), 'utf8')]),
));
const claims = (link: string) => {
  const [payload, signature] = new URL(link).searchParams.get('t')?.split('.') ?? [];
  expect(signature).toBe(createHmac('sha256', LINKS.key).update(payload ?? '').digest('base64url'));
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString());
};

describe('EFS account Files', () => {
  it('lists every file in the account, nested ones too, without hidden folders or another account', async () => {
    const { files } = setup();
    expect(await files.list(ACCOUNT)).toEqual([]);
    await put(HASH, 'report.csv', 'a,b');
    await put(HASH, 'charts/q3.png', 'png');
    await put(HASH, '.uploads/abc', 'partial');
    await put(HASH, 'botcube-harness/.state/x', 'mine');
    await put('ffffffffffffffffffffffffffffffff', 'theirs.txt');
    const listed = await files.list(ACCOUNT);
    expect(listed.map(({ name, size }) => [name, size]).sort()).toEqual([['charts/q3.png', 3], ['report.csv', 3]]);
    expect(listed[0]?.lastModified).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('signs upload and download links the Files Lambda accepts, for this account, for five minutes', async () => {
    const { files } = setup();
    const upload = await files.uploadUrl(ACCOUNT, 'new/notes.md');
    expect(upload.startsWith(LINKS.url)).toBe(true);
    expect(claims(upload)).toEqual({ op: 'put', account: HASH, name: 'new/notes.md', exp: NOW / 1000 + 300 });
    await expect(files.downloadUrl(ACCOUNT, 'new/notes.md')).rejects.toMatchObject({ status: 404 });
    await put(HASH, 'new/notes.md');
    expect(claims(await files.downloadUrl(ACCOUNT, 'new/notes.md'))).toMatchObject({ op: 'get', account: HASH, name: 'new/notes.md' });
    expect(signFilesLink('u', 'k', { op: 'get', account: 'a', name: 'n' }, 1)).toBe(`u?t=${Buffer.from('{"op":"get","account":"a","name":"n","exp":1}').toString('base64url')}.${createHmac('sha256', 'k').update(Buffer.from('{"op":"get","account":"a","name":"n","exp":1}').toString('base64url')).digest('base64url')}`);
  });

  it('refuses an upload over a taken name, into a hidden folder, or out of the account', async () => {
    const { files } = setup();
    await put(HASH, 'taken.txt');
    await expect(files.uploadUrl(ACCOUNT, 'taken.txt')).rejects.toMatchObject({ status: 409 });
    await expect(files.uploadUrl(ACCOUNT, '.secret/x')).rejects.toMatchObject({ status: 400 });
    await expect(files.uploadUrl(ACCOUNT, '../x')).rejects.toMatchObject({ status: 400 });
    await expect(files.downloadUrl(ACCOUNT, '../../etc/passwd')).rejects.toMatchObject({ status: 400 });
  });

  it('removes a file, and answers 404 for one that is not there', async () => {
    const { files } = setup();
    await put(HASH, 'old.txt');
    await files.remove(ACCOUNT, 'old.txt');
    expect(await files.list(ACCOUNT)).toEqual([]);
    await expect(files.remove(ACCOUNT, 'old.txt')).rejects.toMatchObject({ status: 404 });
  });

  it('renames into a new folder but never over another file', async () => {
    const { files } = setup();
    await put(HASH, 'a.txt', 'A');
    await put(HASH, 'b.txt', 'B');
    await expect(files.rename(ACCOUNT, 'a.txt', 'b.txt')).rejects.toMatchObject({ status: 409 });
    expect(await readFile(path.join(root, HASH, 'b.txt'), 'utf8')).toBe('B');
    await files.rename(ACCOUNT, 'a.txt', 'archive/a.txt');
    expect((await files.list(ACCOUNT)).map(({ name }) => name).sort()).toEqual(['archive/a.txt', 'b.txt']);
    await expect(files.rename(ACCOUNT, 'a.txt', 'c.txt')).rejects.toMatchObject({ status: 404 });
  });

  describe("a User's save of an Artifact", () => {
    const COVER = '<section id="cover"><h1>Q3 Operating Review</h1><p>Where we landed</p></section>';
    const AGENDA = '<section id="agenda"><h2>Agenda</h2></section>';
    const EDITED = '<section id="cover"><h1>Q3 Operating Review</h1><p>Where we landed, checked</p></section>';
    const OTHER = 'ffffffffffffffffffffffffffffffff';
    async function published() {
      await Promise.all(['decks/q3', 'artifacts/decks/q3.versions/1'].flatMap((base) => [
        put(HASH, `${base}/project/deck.json`, '{"title":"Q3 Operating Review","order":["cover","agenda"]}'),
        put(HASH, `${base}/project/slides/cover.html`, COVER),
        put(HASH, `${base}/project/slides/agenda.html`, AGENDA),
      ]));
      await put(HASH, 'artifacts/decks/q3.versions/1.json', '{"author":"agent","title":"Q3 Operating Review","description":"Q3 against plan"}');
      await put(HASH, 'artifacts/decks/q3.versions/read.json', '{"version":1}');
    }
    const read = (name: string) => readFile(path.join(root, HASH, name), 'utf8');
    const stored = () => readdir(path.join(root, HASH, 'artifacts/decks/q3.versions'));
    const saveCover = (text = EDITED) => setup().files.saveArtifact(ACCOUNT, { id: '/decks/q3', version: 1, files: { 'project/slides/cover.html': text } });

    it("writes the edited slides into the Source and keeps them as the next version, marked as the User's", async () => {
      await published();

      const saved = await saveCover();

      expect(saved).toEqual({
        id: '/decks/q3', type: 'slides', title: 'Q3 Operating Review', description: 'Q3 against plan', version: 2,
        author: 'user', path: '/artifacts/decks/q3.versions/2',
      });
      expect(await read('decks/q3/project/slides/cover.html')).toBe(EDITED);
      expect(await read('artifacts/decks/q3.versions/2/project/slides/cover.html')).toBe(EDITED);
      expect(await read('artifacts/decks/q3.versions/2/project/slides/agenda.html')).toBe(AGENDA);
      expect(await read('artifacts/decks/q3.versions/1/project/slides/cover.html')).toBe(COVER);
      expect(JSON.parse(await read('artifacts/decks/q3.versions/2.json'))).toEqual({ author: 'user', title: 'Q3 Operating Review', description: 'Q3 against plan' });
      expect(JSON.parse(await read('artifacts/decks/q3.versions/read.json'))).toEqual({ version: 1 });
      expect((await stored()).sort()).toEqual(['1', '1.json', '2', '2.json', 'read.json']);
    });

    it('refuses a save over a newer version, one carrying no file or a file the editor does not edit, and an unknown Artifact', async () => {
      const { files } = setup();
      await published();
      await saveCover();

      await expect(files.saveArtifact(ACCOUNT, { id: '/decks/q3', version: 1, files: { 'project/slides/agenda.html': AGENDA } }))
        .rejects.toMatchObject({ status: 409, message: 'Version 2 of /decks/q3 is newer than the version 1 you edited. Open the newest and edit again.' });
      await expect(files.saveArtifact(ACCOUNT, { id: '/decks/q3', version: 2, files: {} })).rejects.toMatchObject({ status: 400 });
      await Promise.all(['project/deck.json', 'project/slides/new.html', 'project/slides/../../../x.html'].map(async (name) =>
        expect(files.saveArtifact(ACCOUNT, { id: '/decks/q3', version: 2, files: { [name]: AGENDA } })).rejects.toMatchObject({ status: 400 })));
      await expect(files.saveArtifact(ACCOUNT, { id: '/decks/q4', version: 1, files: { 'project/slides/cover.html': EDITED } })).rejects.toMatchObject({ status: 404 });
      expect(await stored()).not.toContain('3');
    });

    it('refuses a version another save claimed first', async () => {
      await published();
      await put(HASH, 'artifacts/decks/q3.versions/2.json', '{"author":"agent","title":"Q3 Operating Review","description":""}');

      await expect(saveCover()).rejects.toMatchObject({ status: 409, message: 'Version 2 of /decks/q3 was saved first. Open the newest and edit again.' });
      expect((await stored()).sort()).toEqual(['1', '1.json', '2.json', 'read.json']);
      expect(await read('decks/q3/project/slides/cover.html')).toBe(COVER);
    });

    it("refuses a save the slide format refuses, with the checker's own errors", async () => {
      await published();

      await expect(saveCover('<section id="cover"><h1>Q3</h1><blink>new</blink></section>')).rejects.toMatchObject({
        status: 400, message: 'project/slides/cover.html:1:33 <blink> — is not in the slide format. Nearest: a <div> or a <p>.',
      });
      expect(await stored()).not.toContain('2');
      expect(await read('decks/q3/project/slides/cover.html')).toBe(COVER);
    });

    it('refuses a page, which is not edited in place', async () => {
      await put(HASH, 'q3.html', '<h1>Q3</h1>');
      await put(HASH, 'artifacts/q3.html.versions/1.html', '<h1>Q3</h1>');
      await put(HASH, 'artifacts/q3.html.versions/1.json', '{"author":"agent","title":"Q3","description":""}');

      await expect(setup().files.saveArtifact(ACCOUNT, { id: '/q3.html', version: 1, files: { 'q3.html': '<h1>Q4</h1>' } }))
        .rejects.toMatchObject({ status: 400, message: 'q3.html is not a file of /q3.html the editor can save' });
    });

    it.each([
      ['a slide file in the Source', 'decks/q3/project/slides/cover.html', `${OTHER}/cover.html`],
      ['the Source folder', 'decks/q3', `${OTHER}/q3`],
      ['a folder of the Source path', 'decks', `${OTHER}/decks`],
      ['a slide in the version the User edited', 'artifacts/decks/q3.versions/1/project/slides/agenda.html', `${OTHER}/agenda.html`],
      ['the version store', 'artifacts/decks/q3.versions', `${OTHER}/versions`],
    ])('refuses a symbolic link at %s and writes nothing outside the account', async (_, link, target) => {
      await published();
      await put(OTHER, 'theirs.txt', 'theirs');
      const linked = path.join(root, HASH, link);
      await cp(linked, path.join(root, target), { recursive: true });
      await rm(linked, { recursive: true });
      await symlink(path.join(root, target), linked);
      const before = await snapshot(path.join(root, OTHER));

      await expect(saveCover()).rejects.toMatchObject({ status: 400, message: expect.stringContaining('is a symbolic link') });

      expect(await snapshot(path.join(root, OTHER))).toEqual(before);
      expect(await readdir(path.join(root, HASH, 'artifacts/decks/q3.versions'))).not.toContain('2');
    });

    describe('of a Doc', () => {
      const PLAN = '# Q4 plan\n\n| Month | Goal |\n| --- | --- |\n| Oct | Beta |\n';
      const SAVED = '# Q4 plan, checked\n\n| Month | Goal |\n| --- | --- |\n| Oct | Public beta |\n';
      async function publishedDoc() {
        await put(HASH, 'plans/q4.md', PLAN);
        await put(HASH, 'artifacts/plans/q4.md.versions/1.md', PLAN);
        await put(HASH, 'artifacts/plans/q4.md.versions/1.json', '{"author":"agent","title":"Q4 plan","description":"The plan"}');
        await put(HASH, 'artifacts/plans/q4.md.versions/read.json', '{"version":1}');
      }

      it('writes the edited Markdown into the Source and keeps it as the next version, the User\'s', async () => {
        const { files } = setup();
        await publishedDoc();

        const saved = await files.saveArtifact(ACCOUNT, { id: '/plans/q4.md', version: 1, files: { 'q4.md': SAVED } });

        expect(saved).toEqual({
          id: '/plans/q4.md', type: 'doc', title: 'Q4 plan', description: 'The plan', version: 2, author: 'user',
          path: '/artifacts/plans/q4.md.versions/2.md',
        });
        expect(await read('plans/q4.md')).toBe(SAVED);
        expect(await read('artifacts/plans/q4.md.versions/2.md')).toBe(SAVED);
        expect(await read('artifacts/plans/q4.md.versions/1.md')).toBe(PLAN);
        expect(JSON.parse(await read('artifacts/plans/q4.md.versions/2.json'))).toEqual({ author: 'user', title: 'Q4 plan', description: 'The plan' });
      });

      it('saves a Doc kept at the root of Files', async () => {
        // Live, the agent wrote its Doc beside no folder, and the save refused `.` as a path in Files.
        const { files } = setup();
        await put(HASH, 'q4.md', PLAN);
        await put(HASH, 'artifacts/q4.md.versions/1.md', PLAN);
        await put(HASH, 'artifacts/q4.md.versions/1.json', '{"author":"agent","title":"Q4 plan","description":"The plan"}');

        const saved = await files.saveArtifact(ACCOUNT, { id: '/q4.md', version: 1, files: { 'q4.md': SAVED } });

        expect(saved).toMatchObject({ id: '/q4.md', version: 2, author: 'user', path: '/artifacts/q4.md.versions/2.md' });
        expect(await read('q4.md')).toBe(SAVED);
        expect(await read('artifacts/q4.md.versions/2.md')).toBe(SAVED);
      });

      it('refuses a save over a newer version and any file but the Doc\'s own', async () => {
        const { files } = setup();
        await publishedDoc();
        await files.saveArtifact(ACCOUNT, { id: '/plans/q4.md', version: 1, files: { 'q4.md': SAVED } });

        await expect(files.saveArtifact(ACCOUNT, { id: '/plans/q4.md', version: 1, files: { 'q4.md': PLAN } }))
          .rejects.toMatchObject({ status: 409 });
        await Promise.all(['q5.md', 'project/slides/cover.html', '../q4.md'].map(async (name) =>
          expect(files.saveArtifact(ACCOUNT, { id: '/plans/q4.md', version: 2, files: { [name]: PLAN } })).rejects.toMatchObject({ status: 400 })));
        expect(await readdir(path.join(root, HASH, 'artifacts/plans/q4.md.versions'))).not.toContain('3.md');
      });

      it('refuses a save carrying no file', async () => {
        await publishedDoc();

        await expect(setup().files.saveArtifact(ACCOUNT, { id: '/plans/q4.md', version: 1, files: {} }))
          .rejects.toMatchObject({ status: 400, message: 'A save of /plans/q4.md carries no edited file' });
        expect((await readdir(path.join(root, HASH, 'artifacts/plans/q4.md.versions'))).sort()).toEqual(['1.json', '1.md', 'read.json']);
      });

      it("refuses a save the Doc's check refuses, naming the line and the nearest Markdown, and keeps a held image", async () => {
        await publishedDoc();
        const save = (text: string) => setup().files.saveArtifact(ACCOUNT, { id: '/plans/q4.md', version: 1, files: { 'q4.md': text } });

        await expect(save(`${PLAN}\nSigned <b>off</b>.\n\n![Logo](https://example.com/logo.png)\n`)).rejects.toMatchObject({
          status: 400,
          message: [
            'q4.md:7:8 <b> — is HTML, which the Doc does not keep: its viewer shows only the text, and the next save drops the HTML. Nearest: **bold**.',
            'q4.md:9:1 ![Logo](https://example.com/logo.png) — is an image the Doc would load from elsewhere, which the app never loads. Nearest: the image itself as a data: URI, ![alt](data:image/png;base64,…).',
          ].join('\n'),
        });
        expect(await read('plans/q4.md')).toBe(PLAN);
        expect(await readdir(path.join(root, HASH, 'artifacts/plans/q4.md.versions'))).not.toContain('2.md');

        const held = `${PLAN}\n![Chart](data:image/png;base64,iVBORw0KGgo=)\n`;
        expect(await save(held)).toMatchObject({ version: 2, type: 'doc' });
        expect(await read('artifacts/plans/q4.md.versions/2.md')).toBe(held);
      });
    });

    it("keeps a Sheet's saved edits as its next version and its Source, and refuses any other file", async () => {
      const { files } = setup();
      const SHEET = '{"edits":[{"kind":"writeCells","sheet":"Budget","topLeft":"A1","rows":[["Rent",1200]]}]}';
      const SAVED = '{"edits":[{"kind":"writeCells","sheet":"Budget","topLeft":"A1","rows":[["Rent",1200]]},{"kind":"writeCells","sheet":"Budget","topLeft":"B1","rows":[[1500]]}]}';
      await put(HASH, 'sheets/budget.sheet.json', SHEET);
      await put(HASH, 'artifacts/sheets/budget.sheet.json.versions/1.sheet.json', SHEET);
      await put(HASH, 'artifacts/sheets/budget.sheet.json.versions/1.json', '{"author":"agent","title":"Budget","description":"Monthly costs"}');
      await put(HASH, 'artifacts/sheets/budget.sheet.json.versions/read.json', '{"version":1}');

      const saved = await files.saveArtifact(ACCOUNT, { id: '/sheets/budget.sheet.json', version: 1, files: { 'budget.sheet.json': SAVED } });

      expect(saved).toEqual({
        id: '/sheets/budget.sheet.json', type: 'sheet', title: 'Budget', description: 'Monthly costs', version: 2,
        author: 'user', path: '/artifacts/sheets/budget.sheet.json.versions/2.sheet.json',
      });
      expect(await read('sheets/budget.sheet.json')).toBe(SAVED);
      expect(await read('artifacts/sheets/budget.sheet.json.versions/2.sheet.json')).toBe(SAVED);
      expect(await read('artifacts/sheets/budget.sheet.json.versions/1.sheet.json')).toBe(SHEET);
      expect(JSON.parse(await read('artifacts/sheets/budget.sheet.json.versions/2.json'))).toEqual({ author: 'user', title: 'Budget', description: 'Monthly costs' });
      await expect(files.saveArtifact(ACCOUNT, { id: '/sheets/budget.sheet.json', version: 1, files: { 'budget.sheet.json': SAVED } }))
        .rejects.toMatchObject({ status: 409 });
      await Promise.all(['other.sheet.json', 'project/slides/cover.html'].map((name) =>
        expect(files.saveArtifact(ACCOUNT, { id: '/sheets/budget.sheet.json', version: 2, files: { [name]: SAVED } })).rejects.toMatchObject({ status: 400 })));
      const CHECKBOX = '{"edits":[{"kind":"formatCells","sheet":"Budget","ranges":["C1"],"format":{"cellControl":{"kind":"checkbox"}}}]}';
      await expect(files.saveArtifact(ACCOUNT, { id: '/sheets/budget.sheet.json', version: 2, files: { 'budget.sheet.json': CHECKBOX } })).rejects.toMatchObject({
        status: 400,
        message: 'budget.sheet.json edit 0 (formatCells) — format.cellControl.kind is "checkbox", which neither the grid nor the Excel file draws yet. '
          + 'Nearest: {"kind": "none"}: write true or false in the cells instead of a checkbox.',
      });
      expect(await readdir(path.join(root, HASH, 'artifacts/sheets/budget.sheet.json.versions'))).not.toContain('3.sheet.json');
    });
    describe('an Email', () => {
      const DRAFT = '{"to":["dana@example.com"],"subject":"Q3 numbers","htmlBody":"<p>Hi Dana</p>"}';
      const EDITED_DRAFT = '{"to":["dana@example.com","lee@example.com"],"subject":"Q3 numbers","htmlBody":"<p>Hi Dana and Lee</p>"}';
      async function drafted() {
        await put(HASH, 'drafts/q3.email.json', DRAFT);
        await put(HASH, 'artifacts/drafts/q3.email.json.versions/1.email.json', DRAFT);
        await put(HASH, 'artifacts/drafts/q3.email.json.versions/1.json', '{"author":"agent","title":"Q3 numbers","description":""}');
        await put(HASH, 'artifacts/drafts/q3.email.json.versions/read.json', '{"version":1}');
      }

      it('writes the edited draft into the Source and keeps it as the next version, marked as the User\'s', async () => {
        const { files } = setup();
        await drafted();

        const saved = await files.saveArtifact(ACCOUNT, { id: '/drafts/q3.email.json', version: 1, files: { 'q3.email.json': EDITED_DRAFT } });

        expect(saved).toEqual({
          id: '/drafts/q3.email.json', type: 'email', title: 'Q3 numbers', description: '', version: 2, author: 'user',
          path: '/artifacts/drafts/q3.email.json.versions/2.email.json',
        });
        expect(await read('drafts/q3.email.json')).toBe(EDITED_DRAFT);
        expect(await read('artifacts/drafts/q3.email.json.versions/2.email.json')).toBe(EDITED_DRAFT);
        expect(await read('artifacts/drafts/q3.email.json.versions/1.email.json')).toBe(DRAFT);
        expect(JSON.parse(await read('artifacts/drafts/q3.email.json.versions/2.json'))).toEqual({ author: 'user', title: 'Q3 numbers', description: '' });
      });

      it('refuses a save over a newer version and any file but the draft', async () => {
        const { files } = setup();
        await drafted();
        await files.saveArtifact(ACCOUNT, { id: '/drafts/q3.email.json', version: 1, files: { 'q3.email.json': EDITED_DRAFT } });

        await expect(files.saveArtifact(ACCOUNT, { id: '/drafts/q3.email.json', version: 1, files: { 'q3.email.json': DRAFT } }))
          .rejects.toMatchObject({ status: 409 });
        await Promise.all(['q4.email.json', 'report.pdf', '../q3.email.json'].map((name) =>
          expect(files.saveArtifact(ACCOUNT, { id: '/drafts/q3.email.json', version: 2, files: { [name]: DRAFT } })).rejects.toMatchObject({ status: 400 })));
        expect(await readdir(path.join(root, HASH, 'artifacts/drafts/q3.email.json.versions'))).not.toContain('3.email.json');
      });

      it('refuses, with 400 and each error, a save that carries no draft, is not JSON or breaks the email format', async () => {
        const { files } = setup();
        await drafted();
        const save = (edited: Record<string, string>) => files.saveArtifact(ACCOUNT, { id: '/drafts/q3.email.json', version: 1, files: edited });

        await expect(save({})).rejects.toMatchObject({ status: 400, message: expect.stringContaining('carries no edited file') });
        await expect(save({ 'q3.email.json': '{"to":["dana@example.com"],' })).rejects.toMatchObject({
          status: 400, message: expect.stringMatching(/^q3\.email\.json draft — is not JSON/),
        });
        await expect(save({ 'q3.email.json': '{"to":"dana@example.com","subject":"Q3\\r\\nBcc: x@example.com","htmlBody":"<table></table>"}' }))
          .rejects.toMatchObject({
            status: 400,
            message: [
              'q3.email.json to — is of type string, not array. Nearest: a list of plain addresses, such as ["dana@example.com"].',
              'q3.email.json subject — is not in the allowed form. Nearest: one line of text, with no line break or control character.',
              'q3.email.json htmlBody <table> — is not an element the email editor holds, so the panel would drop it. Nearest: a <ul> of <li><p> rows, or attach the table as a File.',
            ].join('\n'),
          });
        expect(await readdir(path.join(root, HASH, 'artifacts/drafts/q3.email.json.versions'))).toEqual(['1.email.json', '1.json', 'read.json']);
        expect(await read('drafts/q3.email.json')).toBe(DRAFT);
      });
    });

    it("keeps a Sheet's import steps and their copies in the User's version, and refuses a save that changes a step", async () => {
      const { files } = setup();
      const IMPORT = { kind: 'importFile', asset: '/data/orders.xlsx' };
      const SHEET = JSON.stringify({ edits: [IMPORT] });
      const SAVED = JSON.stringify({ edits: [IMPORT, { kind: 'writeCells', sheet: 'Orders', topLeft: 'B2', rows: [[150]] }] });
      const versions = 'artifacts/sheets/q4.sheet.json.versions';
      const imports = [{ edit: 0, from: '/data/orders.xlsx', path: `/${versions}/imports/0a1b.xlsx` }];
      await put(HASH, 'sheets/q4.sheet.json', SHEET);
      await put(HASH, `${versions}/1.sheet.json`, SHEET);
      await put(HASH, `${versions}/1.json`, JSON.stringify({ author: 'agent', title: 'Q4', description: '', imports }));
      await put(HASH, `${versions}/read.json`, '{"version":1}');

      const dropped = JSON.stringify({ edits: [{ kind: 'writeCells', sheet: 'Orders', topLeft: 'B2', rows: [[150]] }] });
      const swapped = JSON.stringify({ edits: [{ kind: 'importFile', asset: '/data/other.csv' }] });
      const moved = JSON.stringify({ edits: [{ kind: 'writeCells', sheet: 'Notes', topLeft: 'A1', rows: [['n']] }, IMPORT] });
      await Promise.all([dropped, swapped, moved].map(async (text) =>
        expect(files.saveArtifact(ACCOUNT, { id: '/sheets/q4.sheet.json', version: 1, files: { 'q4.sheet.json': text } })).rejects.toMatchObject({
          status: 400, message: 'A save of /sheets/q4.sheet.json keeps the import steps of version 1: edit 0 imports /data/orders.xlsx',
        })));
      const saved = await files.saveArtifact(ACCOUNT, { id: '/sheets/q4.sheet.json', version: 1, files: { 'q4.sheet.json': SAVED } });

      expect(saved).toMatchObject({ version: 2, author: 'user' });
      expect(JSON.parse(await read(`${versions}/2.json`))).toEqual({ author: 'user', title: 'Q4', description: '', imports });
      expect(await read(`${versions}/2.sheet.json`)).toBe(SAVED);
    });
  });

  it('creates one access point per account, once, and mints mount credentials for exactly that one', async () => {
    const { files, access, minted } = setup();
    const mount = await files.mount(ACCOUNT);
    expect(mount).toEqual({ accessPointArn: expect.stringContaining('access-point/fsap-'), fileSystemArn: FILE_SYSTEM_ARN, mountPath: '/mnt/files' });
    await files.mount(ACCOUNT);
    expect(access.created).toEqual([`/accounts/${HASH}`]);
    const binding = await files.mountBinding(ACCOUNT);
    expect(minted).toEqual([mount.accessPointArn]);
    expect(binding).toMatchObject({ fileSystemId: 'fs-0abc', mountTargetIp: '192.0.2.12', region: 'us-east-1', accessPointId: mount.accessPointArn.split('/').pop(), accessKeyId: 'AKIA' });
  });

  it('ignores retired S3 records and keeps the existing EFS record namespace', async () => {
    const { files, records } = setup();
    await records.call('PutItem', new PutCommand({ TableName: 'chat', Item: {
      pk: `FILES#${ACCOUNT}`, sk: 'META', accessPointArn: 'arn:aws:s3files:us-east-1:123456789012:access-point/s3ap-retired',
    } }));
    const mounted = await files.mount(ACCOUNT);
    expect(mounted.accessPointArn).toContain(':elasticfilesystem:');
    expect(await records.filesAccessPoint(ACCOUNT)).toBe(mounted.accessPointArn);
    await files.delete(ACCOUNT);
    expect(await records.filesAccessPoint(ACCOUNT)).toBeNull();
  });

  it('a Claim moves every file into the claiming account, a taken name getting the next free one, and retires the source', async () => {
    const { files, records, access } = setup();
    await records.call('PutItem', new PutCommand({ TableName: 'chat', Item: { pk: 'ACCOUNT#acct_claimed', sk: 'META', record: { accountId: 'acct_claimed' } } }));
    await files.mount(ACCOUNT);
    await put(HASH, 'report.csv', 'anonymous');
    await put(HASH, 'sub/deep.txt', 'deep');
    const destination = (await files.mount('acct_claimed')).accessPointArn;
    const claimedHash = path.basename(access.live.get(destination) ?? '');
    await put(claimedHash, 'report.csv', 'claimed');
    await files.transfer(ACCOUNT, 'acct_claimed');
    expect((await files.list('acct_claimed')).map(({ name }) => name).sort()).toEqual(['report (1).csv', 'report.csv', 'sub/deep.txt']);
    expect(await readFile(path.join(root, claimedHash, 'report.csv'), 'utf8')).toBe('claimed');
    expect(await readFile(path.join(root, claimedHash, 'report (1).csv'), 'utf8')).toBe('anonymous');
    await expect(readdir(path.join(root, HASH))).rejects.toMatchObject({ code: 'ENOENT' });
    expect([...access.live.keys()]).toEqual([destination]);
    await expect(files.uploadUrl(ACCOUNT, 'x')).rejects.toMatchObject({ status: 409 });
    await expect(files.mount(ACCOUNT)).rejects.toMatchObject({ status: 409 });
    await expect(files.mountBinding(ACCOUNT)).rejects.toMatchObject({ status: 409 });
  });

  it('account deletion removes the directory and the access point; a late write is swept until a day past the last credential', async () => {
    const { files, records, access } = setup();
    await files.mount(ACCOUNT);
    await put(HASH, 'a.txt');
    await files.delete(ACCOUNT);
    expect(access.live.size).toBe(0);
    await expect(readdir(path.join(root, HASH))).rejects.toMatchObject({ code: 'ENOENT' });
    // A session mounted before deletion still writes until its credentials run out.
    await put(HASH, 'late.txt');
    vi.mocked(Date.now).mockReturnValue(NOW + 3_600_000);
    await files.recoverCleanup();
    await expect(readdir(path.join(root, HASH))).rejects.toMatchObject({ code: 'ENOENT' });
    // Still inside the grace day: the cleanup comes back an hour later.
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * 3_600_000);
    expect(await records.pendingFilesCleanup()).toContain(ACCOUNT);
    vi.mocked(Date.now).mockReturnValue(NOW + 3_600_000 + 24 * 3_600_000 + 1);
    await files.recoverCleanup();
    expect(await records.pendingFilesCleanup()).not.toContain(ACCOUNT);
  });
});
