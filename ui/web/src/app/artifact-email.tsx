"use client";

import { EditorContent, generateJSON, generateText, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { readDraft, type EmailDraft } from "botcube-artifact-check/email-schema";
import type { Imported } from "botcube-artifact-check/record";
import { m as motionElement } from "framer-motion";
import { MailIcon, PaperclipIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { recordOf } from "./artifact-newest";
import {
  pdfOf, saveFile, storedVersion, type ArtifactEdit, type ArtifactVersion, type Export, type ExportTarget, type ViewerProps,
} from "./artifact-viewer";
import { Presence, presenceMotion } from "./collapse";
import { reason } from "./composer-files";

/**
 * An Email (ADR 0087): a draft in Gmail's draft fields, shown as Gmail shows one, with header fields and Tiptap on the
 * body. Save sends the draft to the Chat Service, which checks it against the email format as the agent's publish
 * does and keeps it as the Artifact's next version, the User's. The panel's Download builds an unsent `.eml` from the
 * stored version on screen, never from unsaved edits, attaching the copies of the Files that version keeps.
 */

/**
 * The body editor's schema: exactly the elements `botcube-artifact-check/email-html` lets an htmlBody hold, so the
 * panel shows what the `.eml` sends and an edit loses nothing.
 */
export const EMAIL_EDITOR = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] }, code: false, codeBlock: false,
    link: { openOnClick: false, HTMLAttributes: { target: null, rel: null } },
  }),
];

const RECIPIENTS = ["to", "cc", "bcc"] as const;
type Recipients = Record<(typeof RECIPIENTS)[number], string>;
const LABELS = { to: "To", cc: "Cc", bcc: "Bcc" } as const;

const addresses = (text: string) => text.split(/[,;]/).map((address) => address.trim()).filter(Boolean);
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** The body's text, paragraphs apart by a blank line, as a plain-text email writes them. */
const plainOf = (html: string) => generateText(generateJSON(html, EMAIL_EDITOR), EMAIL_EDITOR, { blockSeparator: "\n\n" });

/** The draft as edited: a field the agent left out stays out unless the User filled it. */
function draftOf(loaded: EmailDraft, recipients: Recipients, subject: string, html: string | null): EmailDraft {
  const draft: EmailDraft = { ...loaded };
  for (const field of RECIPIENTS) {
    const list = addresses(recipients[field]);
    if (list.length > 0 || loaded[field] !== undefined) draft[field] = list;
  }
  if (subject !== "" || loaded.subject !== undefined) draft.subject = subject;
  if (html !== null) {
    draft.htmlBody = html;
    if (loaded.body !== undefined) draft.body = plainOf(html);
  }
  return draft;
}

/**
 * The Email's PDF, what a failed `.eml` offers instead: the draft as the panel shows it, unsaved edits included, which
 * the app's print stylesheet (`@media print`) limits to the draft.
 */
const EMAIL_PDF = pdfOf(() => window.print(), false);

/** The panel's Export of an Email: the stored version on screen as an unsent `.eml`. */
export const EML: Export = {
  label: "Download .eml",
  Icon: MailIcon,
  failed: "the .eml",
  stored: true,
  instead: EMAIL_PDF,
  run: async (target) => {
    const version = storedVersion(target, "the draft");
    const [text, { imports = [] }] = await Promise.all([target.read(version.path), recordOf(version.path, target.read)]);
    const draft = readDraft(text);
    const [{ emlOf }, attached] = await Promise.all([
      import("./email-export"),
      Promise.all((draft.attachments ?? []).map(async ({ file, filename, mimeType }, index) => ({
        filename: filename ?? nameOf(file),
        mimeType: mimeType ?? "application/octet-stream",
        bytes: await keptBytes(target, imports.find(({ edit }) => edit === index), file),
      }))),
    ]);
    saveFile(emlOf(draft, draft.body ?? plainOf(draft.htmlBody), attached), `${draft.subject || nameOf(version.id).replace(/\.email\.json$/, "")}.eml`);
  },
};

type Loaded = { path: string } & ({ draft: EmailDraft } | { error: string });

function useDraft(path: string, read: ViewerProps["read"]): Loaded | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let current = true;
    read(path).then(
      (text) => current && setLoaded({ path, draft: readDraft(text) }),
      (error: unknown) => current && setLoaded({ path, error: reason(error) }),
    ).catch((error: unknown) => current && setLoaded({ path, error: `it is not an email draft: ${reason(error)}` }));
    return () => {
      current = false;
    };
  }, [path, read]);
  return loaded?.path === path ? loaded : null;
}

/**
 * The Email's Viewer. It follows the Artifact's newest version until the User edits, then holds the version they
 * edit: a newer one arriving is announced, and the edits drop only on Save, Cancel or "Discard edits and open".
 */
export function EditableEmail({ artifact: newest, read, save, shows }: ViewerProps) {
  const [held, setHeld] = useState<ArtifactVersion | null>(null);
  const [edited, setEdited] = useState(false);
  const [opened, setOpened] = useState(0);
  const shown = held ?? newest;
  const loaded = useDraft(shown.path, read);
  useEffect(() => {
    shows({ version: shown, unsaved: edited });
  }, [shows, shown, edited]);
  const close = () => {
    setHeld(null);
    setEdited(false);
    setOpened((count) => count + 1);
  };
  return (
    <>
      <Presence>{loaded !== null && "error" in loaded && (
        <motionElement.p {...presenceMotion} role="alert" className="artifact-refused">Couldn&apos;t open {shown.title}: {loaded.error}</motionElement.p>
      )}</Presence>
      <Presence>{loaded !== null && "draft" in loaded && (
        <motionElement.div {...presenceMotion} key={`${loaded.path}#${opened}`} className="artifact-email">
          <DraftForm version={shown} newest={newest} loaded={loaded.draft} close={close}
            edits={(now) => {
              setEdited(now);
              if (now) setHeld((current) => current ?? shown);
            }}
            save={async (edit) => {
              await save(edit);
              close();
            }} />
        </motionElement.div>
      )}</Presence>
    </>
  );
}

function DraftForm({ version, newest, loaded, edits, close, save }: {
  version: ArtifactVersion;
  newest: ArtifactVersion;
  loaded: EmailDraft;
  edits: (edited: boolean) => void;
  close: () => void;
  save: (edit: ArtifactEdit) => Promise<void>;
}) {
  const [recipients, setRecipients] = useState<Recipients>(() => {
    const { to, cc, bcc } = loaded;
    return { to: to?.join(", ") ?? "", cc: cc?.join(", ") ?? "", bcc: bcc?.join(", ") ?? "" };
  });
  const [subject, setSubject] = useState(loaded.subject ?? "");
  const [html, setHtml] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const editor = useEditor({
    extensions: EMAIL_EDITOR,
    content: loaded.htmlBody,
    immediatelyRender: true,
    editorProps: { attributes: { role: "textbox", "aria-label": "Body", "aria-multiline": "true", class: "artifact-email-body" } },
    onUpdate: ({ editor: changed }) => setHtml(changed.getHTML()),
  });
  const draft = () => draftOf(loaded, recipients, subject, html);
  const name = nameOf(version.id);
  const edited = JSON.stringify(draft()) !== JSON.stringify(loaded);
  useEffect(() => {
    edits(edited);
  }, [edited, edits]);

  const run = async (action: () => Promise<void>, failed: string) => {
    setBusy(true);
    setFailures([]);
    try {
      await action();
    } catch (error) {
      setFailures(reason(error).split("\n").map((line) => `${failed}: ${line}`));
    } finally {
      setBusy(false);
    }
  };
  const submit = () => run(() => save({ id: version.id, version: version.version, files: { [name]: JSON.stringify(draft(), null, 2) } }), "Couldn't save");
  return (
    <>
      <div className="artifact-edit-bar">
        <button type="button" className="header-btn artifact-edit-action" disabled={!edited || busy} onClick={() => void submit()}>Save</button>
        <button type="button" className="header-btn artifact-edit-action" disabled={!edited || busy} onClick={close}>Cancel</button>
      </div>
      <Presence>{edited && !busy && newest.version > version.version && (
        <motionElement.div {...presenceMotion} role="status" className="artifact-edit-newer">
          <span>Version {newest.version} arrived while you edited version {version.version}. Your edits are kept.</span>
          <button type="button" className="header-btn artifact-edit-action" onClick={close}>Discard edits and open version {newest.version}</button>
        </motionElement.div>
      )}</Presence>
      <Presence>{failures.map((failure) => (
        <motionElement.p key={failure} {...presenceMotion} role="alert" className="artifact-refused artifact-edit-failure">{failure}</motionElement.p>
      ))}</Presence>
      <div className="artifact-email-fields">
        {RECIPIENTS.map((field) => (
          <label key={field} className="artifact-email-field">
            <span>{LABELS[field]}</span>
            <input type="text" aria-label={LABELS[field]} value={recipients[field]}
              onChange={(event) => setRecipients((current) => ({ ...current, [field]: event.target.value }))} />
          </label>
        ))}
        <label className="artifact-email-field">
          <span>Subject</span>
          <input type="text" aria-label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} />
        </label>
      </div>
      <EditorContent editor={editor} className="artifact-email-editor" />
      <ul aria-label="Attachments" className="artifact-email-attachments" hidden={!loaded.attachments?.length}>
        {(loaded.attachments ?? []).map(({ file, filename }) => (
          <li key={file}><PaperclipIcon aria-hidden />{filename ?? nameOf(file)}</li>
        ))}
      </ul>
    </>
  );
}

/**
 * An attachment's bytes, from the copy the version keeps of its File (`kept`, from the version's record): the File may
 * have changed or gone since the publish.
 */
async function keptBytes({ readBytes }: ExportTarget, kept: Imported | undefined, file: string): Promise<Uint8Array> {
  if (kept === undefined) throw new Error(`this version keeps no copy of the attachment ${file}`);
  try {
    return new Uint8Array(await readBytes(kept.path));
  } catch (error) {
    throw new Error(`the attachment ${file} couldn't be read: ${reason(error)}`, { cause: error });
  }
}
