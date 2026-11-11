import { afterEach, expect, it, vi } from 'vitest';

import { readBytes, readFile } from './artifact-files';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Files holding `files` by name: the Chat Service's download URL names the file, and that URL serves it. */
function filesHolding(files: Record<string, string>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    if (input.startsWith('https://files.test/')) return new Response(files[decodeURIComponent(input.slice('https://files.test/'.length))]);
    const name = new URL(input).searchParams.get('name') ?? '';
    asked.push(name);
    return name in files ? Response.json({ url: `https://files.test/${encodeURIComponent(name)}` }) : Response.json({ detail: 'missing' }, { status: 404 });
  }));
  return asked;
}

it('reads a file whose name has a space or a percent sign by that name, as text and as bytes', async () => {
  const name = 'artifacts/notes/Q3 review 100%.md.versions/1.md';
  const asked = filesHolding({ [name]: '# Q3' });

  expect(await readFile(`/${name}`)).toBe('# Q3');
  expect(new TextDecoder().decode(await readBytes(`/${name}`))).toBe('# Q3');
  expect(asked).toEqual([name, name]);
});
