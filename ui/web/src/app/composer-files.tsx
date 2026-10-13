"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FileText, X } from "lucide-react";
import type { WebUiPlugin } from "../cartridge/index.js";
import { attachmentAccountEpoch, subscribeAttachmentAccount } from "../cartridge/file-account";

type Upload = NonNullable<WebUiPlugin["uploadFile"]>;

/** Where a file the user attached stands: on its way to the agent's files, there by its path, or refused and why. */
type ComposerFileState = { status: "uploading"; progress: number } | { status: "uploaded"; path: string } | { status: "failed"; error: string };

export interface ComposerFile {
  id: string;
  file: File;
  state: ComposerFileState;
}

export interface ComposerFiles {
  files: ComposerFile[];
  add: (list: FileList | File[]) => void;
  retry: (id: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Whether the message may go: every file attached has uploaded. */
  sendable: boolean;
}

const unavailableAccountEpoch = Symbol("attachment account storage unavailable");

function probeAttachmentAccountEpoch(): string | null | typeof unavailableAccountEpoch {
  try {
    return attachmentAccountEpoch();
  } catch {
    // A failed storage probe disables attachment sending; uploads report the storage failure on their chip.
    return unavailableAccountEpoch;
  }
}

/**
 * The files attached in a chat's composer, each uploading as it is added; null without the cartridge's `upload`, as the
 * composer then has no +. Removing a file, or the composer unmounting, aborts its upload.
 */
export function useComposerFiles(upload: Upload | undefined, accountId: string | undefined): ComposerFiles | null {
  const epoch = useSyncExternalStore(subscribeAttachmentAccount, probeAttachmentAccountEpoch, () => null);
  const [state, setState] = useState({ accountId, epoch, files: [] as ComposerFile[] });
  const files = state.files;
  const setFiles = (change: (current: ComposerFile[]) => ComposerFile[]) => setState((current) => ({ ...current, files: change(current.files) }));
  const uploads = useRef(new Map<string, AbortController>());
  const nextId = useRef(0);
  useEffect(() => {
    setState({ accountId, epoch, files: [] });
    const running = uploads.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      running.clear();
    };
  }, [accountId, epoch]);
  if (!upload) return null;

  // A file removed meanwhile matches no entry, so an update never brings its chip back.
  const settle = (id: string, state: ComposerFileState) => setFiles((current) => current.map((entry) => (entry.id === id ? { ...entry, state } : entry)));
  const start = (id: string, file: File) => {
    // The Harness keeps hidden files out of the agent's workspace, so the agent could never read one.
    if (file.name.startsWith(".")) {
      settle(id, { status: "failed", error: `The agent can't read hidden files like ${file.name}. Rename it without the leading dot.` });
      return;
    }
    const controller = new AbortController();
    uploads.current.set(id, controller);
    settle(id, { status: "uploading", progress: 0 });
    void upload(file, { onProgress: (progress) => settle(id, { status: "uploading", progress }), signal: controller.signal }).then(
      (path) => settle(id, { status: "uploaded", path }),
      (error: Error) => {
        if (!controller.signal.aborted) settle(id, { status: "failed", error: error.message });
      },
    ).finally(() => uploads.current.delete(id));
  };
  const abort = (id: string) => {
    uploads.current.get(id)?.abort();
    uploads.current.delete(id);
  };
  return {
    files,
    add: (list) => {
      const added = [...list].map((file): ComposerFile => ({ id: String((nextId.current += 1)), file, state: { status: "uploading", progress: 0 } }));
      setFiles((current) => [...current, ...added]);
      for (const { id, file } of added) start(id, file);
    },
    retry: (id) => {
      const entry = files.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`No attached file ${id} to retry`);
      start(id, entry.file);
    },
    remove: (id) => {
      abort(id);
      setFiles((current) => current.filter((entry) => entry.id !== id));
    },
    clear: () => {
      for (const id of [...uploads.current.keys()]) abort(id);
      setFiles(() => []);
    },
    get sendable() {
      return state.accountId === accountId && state.epoch === probeAttachmentAccountEpoch() && (files.length === 0 || state.epoch !== unavailableAccountEpoch) && files.every(({ state }) => state.status === "uploaded");
    },
  };
}

/** The message as sent: its text, then the paths the agent reads the attached files by in this Turn. */
export function messageWithFiles(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  return `${text}\n\nAttached files:\n${paths.map((path) => `- ${path}`).join("\n")}`;
}

/** What a file is, as its chip's second line names it: its extension, or File. */
function kindOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "File" : name.slice(dot + 1).toUpperCase();
}

/** The attached files, as chips in the composer above its text: each one's name and upload, and its Remove. */
export function ComposerFileChips({ files, onRetry, onRemove }: { files: ComposerFile[]; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
  return (
    <ul className="composer-files" aria-label="Attached files">
      {files.map(({ id, file: { name }, state }) => (
        <li key={id} className="composer-file" data-status={state.status}>
          <span className="composer-file-icon" aria-hidden="true">
            <FileText />
          </span>
          <span className="composer-file-text">
            <span className="composer-file-name" title={name}>{name}</span>
            {state.status === "uploading" && (
              <span
                className="composer-file-detail"
                role="progressbar"
                aria-label={`Uploading ${name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(state.progress * 100)}
              >
                {`Uploading… ${Math.round(state.progress * 100)}%`}
                <span className="composer-file-bar">
                  <span style={{ width: `${state.progress * 100}%` }} />
                </span>
              </span>
            )}
            {state.status === "uploaded" && <span className="composer-file-detail">{kindOf(name)}</span>}
            {state.status === "failed" && (
              <>
                <span className="composer-file-error" role="alert">{state.error}</span>
                <button type="button" className="composer-file-retry" onClick={() => onRetry(id)}>Retry</button>
              </>
            )}
          </span>
          <button type="button" className="composer-file-remove" aria-label={`Remove ${name}`} onClick={() => onRemove(id)}>
            <X aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * The composer's file picker, which its + opens, and the chips of the files attached, portalled inside CopilotKit's
 * composer box (the `.copilotKitInput` beside the picker in the overlay), above the text.
 */
export function ComposerFilePicker({ attached, picker }: { attached: ComposerFiles; picker: RefObject<HTMLInputElement | null> }) {
  const [box, setBox] = useState<Element | null>(null);
  useLayoutEffect(() => setBox(picker.current?.parentElement?.querySelector(".copilotKitInput") ?? null), [picker]);
  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          attached.add([...(event.currentTarget.files ?? [])]);
          // The same file can be picked again, as after removing it.
          event.currentTarget.value = "";
        }}
      />
      {box && attached.files.length > 0 && createPortal(
        <ComposerFileChips files={attached.files} onRetry={attached.retry} onRemove={attached.remove} />,
        box,
      )}
    </>
  );
}
