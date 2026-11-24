"use client";

import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Fades } from "./motion";
import { FileTextIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  pdfOf, saveFile, storedVersion, type ArtifactVersion, type Export, type ExportTarget, type ViewerProps,
} from "./artifact-viewer";
import { CouldntOpen, EditFailures, NewerVersion } from "./alert-line";
import { reason } from "./composer-files";
import { baseOf, type FilesPath } from "./files-path";
import { Button } from "@/components/ui/button";

const EXTENSIONS = [
  // StarterKit 3 underlines on Mod-U, and @tiptap/markdown writes an underline as <u>, HTML a Doc does not keep.
  StarterKit.configure({ link: { openOnClick: false }, underline: false }),
  TableKit,
  TaskList,
  TaskItem.configure({ nested: true }),
  Image.configure({ allowBase64: true }),
  Markdown,
];

function useDoc(label: string, markdown: string, editable: boolean, onUpdate?: (markdown: string) => void) {
  return useEditor({
    extensions: EXTENSIONS,
    content: markdown,
    contentType: "markdown",
    editable,
    immediatelyRender: true,
    editorProps: { attributes: { role: "textbox", "aria-label": label, "aria-multiline": "true", "aria-readonly": String(!editable), class: "artifact-doc" } },
    onUpdate: ({ editor }) => onUpdate?.(editor.getMarkdown()),
  });
}

export function DocFrame({ title, markdown }: { title: string; markdown: string }) {
  const editor = useDoc(title, markdown, false);
  useEffect(() => {
    editor.commands.setContent(markdown, { contentType: "markdown" });
  }, [editor, markdown]);
  return <div className="artifact-doc-page"><EditorContent editor={editor} /></div>;
}

function useMarkdown(version: ArtifactVersion, read: (path: FilesPath) => Promise<string>) {
  const [loaded, setLoaded] = useState<{ version: ArtifactVersion } & ({ markdown: string } | { error: string }) | null>(null);
  useEffect(() => {
    let current = true;
    read(version.path).then(
      (markdown) => current && setLoaded({ version, markdown }),
      (error: unknown) => current && setLoaded({ version, error: reason(error) }),
    );
    return () => {
      current = false;
    };
  }, [version, read]);
  return loaded;
}

export function EditableDoc({ artifact: newest, read, save, shows }: ViewerProps) {
  const [edit, setEdit] = useState<{ version: ArtifactVersion; markdown: string } | null>(null);
  const [opened, setOpened] = useState(0);
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const loaded = useMarkdown(edit?.version ?? newest, read);
  const doc = loaded?.version ?? newest;
  const unsaved = edit !== null;
  useEffect(() => shows({ version: doc, unsaved }), [shows, doc, unsaved]);
  const stop = () => {
    setEdit(null);
    setFailures([]);
    setOpened((count) => count + 1);
  };
  const submit = async () => {
    if (edit === null) return;
    setSaving(true);
    setFailures([]);
    try {
      const name = baseOf(edit.version.id);
      await save({ id: edit.version.id, version: edit.version.version, files: { [name]: edit.markdown } });
      setEdit(null);
    } catch (error) {
      setFailures(reason(error).split("\n").map((line) => `Couldn't save: ${line}`));
    } finally {
      setSaving(false);
    }
  };

  if (loaded === null) return <p className="artifact-status">Opening {doc.title}…</p>;
  if ("error" in loaded) return <CouldntOpen title={doc.title} why={loaded.error} />;
  return (
    <>
      <div className="artifact-edit-bar">
        <Button type="button" variant="ghost" size="sm" disabled={edit === null || saving} onClick={() => void submit()}>Save</Button>
        <Button type="button" variant="ghost" size="sm" disabled={edit === null || saving} onClick={stop}>Discard</Button>
      </div>
      <Fades>{edit !== null && !saving && newest.version > edit.version.version && (
        <NewerVersion newest={newest.version} edited={edit.version.version} onDiscard={stop} />
      )}</Fades>
      <EditFailures failures={failures} />
      <div className="artifact-doc-page"><DocEditor key={`${doc.path}:${opened}`} title={doc.title} markdown={loaded.markdown}
        onEdit={(markdown) => setEdit({ version: doc, markdown })} /></div>
    </>
  );
}

function DocEditor({ title, markdown, onEdit }: { title: string; markdown: string; onEdit: (markdown: string) => void }) {
  const editor = useDoc(title, markdown, true, onEdit);
  return <EditorContent editor={editor} />;
}

function htmlOf(markdown: string): string {
  const editor = new Editor({ extensions: EXTENSIONS, content: markdown, contentType: "markdown" });
  try {
    return editor.getHTML();
  } finally {
    editor.destroy();
  }
}

/** The Markdown of the stored version on screen, which the Doc's Exports are made from. */
const storedMarkdown = (target: ExportTarget) => target.read(storedVersion(target, "the Doc").path);

/** The Doc's PDF prints its stored version on screen, in a frame of its own. */
const DOC_PDF = pdfOf(async (target) => printDoc(htmlOf(await storedMarkdown(target)), target.title), true);

const WORD: Export = {
  label: "Word",
  Icon: FileTextIcon,
  failed: "the Word file",
  stored: true,
  instead: DOC_PDF,
  run: async (target) => {
    const [{ wordOf }, markdown] = await Promise.all([import("./doc-word"), storedMarkdown(target)]);
    saveFile(await wordOf(htmlOf(markdown), target.title), `${target.title}.docx`);
  },
};

export const DOC_EXPORTS = [WORD, DOC_PDF] as const;

const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// A sandboxed frame's print() is reachable from the app only when the frame shares the app's origin.
function printDoc(html: string, title: string) {
  const frame = Object.assign(document.createElement("iframe"), { title: `${title} for print`, hidden: true });
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.srcdoc = `<!doctype html><meta charset="utf-8"><title>${escaped(title)}</title><style>body{font:16px/1.5 Inter,system-ui,sans-serif;margin:2cm}img{max-width:100%}table{border-collapse:collapse}th,td{border:1px solid;padding:4px 8px}</style>${html}`;
  frame.addEventListener("load", () => {
    frame.contentWindow?.addEventListener("afterprint", () => frame.remove());
    frame.contentWindow?.print();
  });
  document.body.append(frame);
}
