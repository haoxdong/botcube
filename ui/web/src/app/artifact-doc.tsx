"use client";

import Image from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { EditorState } from "@tiptap/pm/state";
import { createDocument, Editor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Fades } from "./motion";
import { FileTextIcon } from "lucide-react";
import { createContext, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import {
  pdfOf, saveFile, storedVersion, type ArtifactVersion, type Export, type ExportTarget, type ViewerProps,
} from "./artifact-viewer";
import { CouldntOpen, EditFailures, NewerVersion } from "./alert-line";
import { reason } from "./composer-files";
import { useLoad } from "./load-state";
import { baseOf } from "./files-path";
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

const docAttributes = (title: string, editable: boolean) => ({
  role: "textbox", "aria-label": title, "aria-multiline": "true", "aria-readonly": String(!editable), class: "artifact-doc",
});

function docOptions(title: string, markdown: string, editable: boolean) {
  return {
    extensions: EXTENSIONS,
    content: markdown,
    contentType: "markdown" as const,
    editable,
    editorProps: { attributes: docAttributes(title, editable) },
  };
}

type PreparedEditor = { editor: Editor; style: HTMLStyleElement };
const PreparedDoc = createContext<RefObject<PreparedEditor | null> | null>(null);

export function PrepareDocEditor({ ready, children }: { ready: boolean; children: ReactNode }) {
  const prepared = useRef<PreparedEditor | null>(null);
  useEffect(() => {
    if (!ready || prepared.current || typeof requestIdleCallback !== "function") return;
    const idle = requestIdleCallback(() => {
      const editor = new Editor(docOptions("", "", true));
      const style = document.head.querySelector<HTMLStyleElement>("style[data-tiptap-style]");
      if (style) prepared.current = { editor, style };
      else editor.destroy();
    });
    return () => cancelIdleCallback(idle);
  }, [ready]);
  useEffect(() => () => {
    prepared.current?.editor.destroy();
    prepared.current = null;
  }, []);
  return <PreparedDoc.Provider value={prepared}>{children}</PreparedDoc.Provider>;
}

function openEditor(prepared: RefObject<PreparedEditor | null> | null, title: string, markdown: string) {
  const ready = prepared?.current;
  if (!prepared || !ready) return new Editor(docOptions(title, markdown, true));
  const { editor, style } = ready;
  // TipTap removes its shared stylesheet when the last attached editor goes away.
  if (!style.isConnected || !editor.markdown) {
    editor.destroy();
    prepared.current = null;
    return new Editor(docOptions(title, markdown, true));
  }
  const json = editor.markdown.parse(markdown);
  const doc = createDocument(json.content?.length ? json : markdown, editor.schema);
  const state = EditorState.create({ doc, plugins: editor.state.plugins });
  // Recreate the document state so loading it never enters the User's undo history.
  editor.view.update({ ...editor.view.props, state, attributes: docAttributes(title, true) });
  prepared.current = null;
  return editor;
}

export function DocFrame({ title, markdown }: { title: string; markdown: string }) {
  const editor = useEditor({ ...docOptions(title, markdown, false), immediatelyRender: true });
  useEffect(() => {
    editor.commands.setContent(markdown, { contentType: "markdown" });
  }, [editor, markdown]);
  return <div className="artifact-doc-page"><EditorContent editor={editor} /></div>;
}

export function EditableDoc({ artifact: newest, read, save, shows }: ViewerProps) {
  const [edit, setEdit] = useState<{ version: ArtifactVersion; markdown: string } | null>(null);
  const [opened, setOpened] = useState(0);
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const version = edit?.version ?? newest;
  const key = useMemo(() => ({ version, read }), [version, read]);
  const { state: loaded, resultKey } = useLoad(() => read(version.path), key);
  const doc = resultKey?.version ?? newest;
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

  if (loaded.status === "loading") return <p className="artifact-status">Opening {doc.title}…</p>;
  if (loaded.status === "failed") return <CouldntOpen title={doc.title} why={loaded.error} />;
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
      <div className="artifact-doc-page"><DocEditor key={`${doc.path}:${opened}`} title={doc.title} markdown={loaded.value}
        onEdit={(markdown) => setEdit({ version: doc, markdown })} /></div>
    </>
  );
}

function DocEditor({ title, markdown, onEdit }: { title: string; markdown: string; onEdit: (markdown: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const prepared = useContext(PreparedDoc);
  const edited = useEffectEvent(onEdit);
  const create = useEffectEvent(() => openEditor(prepared, title, markdown));
  useLayoutEffect(() => {
    const instance = create();
    instance.on("update", () => edited(instance.getMarkdown()));
    editor.current = instance;
    // Doc node views are native. EditorContent would redraw them to initialize React node views.
    host.current?.append(instance.view.dom);
    return () => {
      editor.current = null;
      instance.destroy();
    };
  }, []);
  useLayoutEffect(() => {
    const instance = editor.current;
    if (instance && instance.view.dom.getAttribute("aria-label") !== title) {
      instance.setOptions({ editorProps: { attributes: docAttributes(title, true) } });
    }
  }, [title]);
  return <div ref={host} />;
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
