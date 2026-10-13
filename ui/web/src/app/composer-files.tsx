"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { File as FileIcon, FileSpreadsheet, FileText, RotateCw, X } from "lucide-react";
import { attachmentAccountEpoch, subscribeAttachmentAccount } from "../cartridge/file-account";

type Upload = (file: File, options: { onProgress: (fraction: number) => void; signal: AbortSignal }) => Promise<string>;

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
 * The files attached in a chat's composer, each uploading as it is added. Removing a file, or the composer unmounting,
 * aborts its upload.
 */
export function useComposerFiles(upload: Upload, accountId: string | undefined): ComposerFiles {
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
    // With no file attached, the message names no path another account could own, so neither the account nor storage holds it.
    get sendable() {
      if (files.length === 0) return true;
      return state.accountId === accountId && state.epoch === probeAttachmentAccountEpoch() && state.epoch !== unavailableAccountEpoch && files.every(({ state }) => state.status === "uploaded");
    },
  };
}

/**
 * A pasted image's name, as macOS names a screenshot, for when it was pasted: browsers name every clipboard image
 * `image.png`. Two pasted in the same second take Files' next copy name, as any repeated name does.
 */
function pastedImageName(file: File, at: Date): string {
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot + 1) : file.type.slice("image/".length);
  const two = (part: number) => String(part).padStart(2, "0");
  const hour = at.getHours();
  const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  return `Pasted image ${date} at ${hour % 12 || 12}.${two(at.getMinutes())}.${two(at.getSeconds())} ${hour < 12 ? "AM" : "PM"}.${extension}`;
}

/**
 * The composer text box's paste: the clipboard's images attach as Add photos would, each named for when it was pasted;
 * a clipboard holding text pastes only its text.
 */
export function attachPastedImages(add: ComposerFiles["add"]) {
  return ({ clipboardData }: ClipboardEvent) => {
    // Copied text pastes as text, though Office apps put a picture of it beside it on the clipboard.
    if (clipboardData.types.includes("text/plain")) return;
    const files = clipboardData.files.length > 0 ? [...clipboardData.files] : [...clipboardData.items].flatMap((item) => (item.kind === "file" ? [item.getAsFile()] : []));
    const images = files.filter((file): file is File => file?.type.startsWith("image/") === true);
    if (images.length === 0) return;
    const at = new Date();
    add(images.map((image) => new File([image], pastedImageName(image, at), { type: image.type, lastModified: image.lastModified })));
  };
}

/** The message as sent: its text, then the paths the agent reads the attached files by in this Turn. */
export function messageWithFiles(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  return `${text}\n\nAttached files:\n${paths.map((path) => `- ${path}`).join("\n")}`;
}

/** A sent message's text and its files' paths, read back from the block `messageWithFiles` ends it with. */
export function sentFilesOf(message: string): { text: string; paths: string[] } {
  const match = /^([\s\S]*)\n\nAttached files:\n(- .*(?:\n- .*)*)$/.exec(message);
  if (!match) return { text: message, paths: [] };
  return { text: match[1] ?? "", paths: (match[2] ?? "").split("\n").map((line) => line.slice(2)) };
}

/** What a file is, as its chip's second line names it: its extension, or File. */
function kindOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "File" : name.slice(dot + 1).toUpperCase();
}

/** The kinds of file a tile is tinted for; any other is a plain file. */
const SHEETS = new Set(["CSV", "XLS", "XLSX"]);
const TILES = { pdf: FileText, sheet: FileSpreadsheet, file: FileIcon };
const tileOf = (kind: string): keyof typeof TILES => (kind === "PDF" ? "pdf" : SHEETS.has(kind) ? "sheet" : "file");

/** A file's tile, the same in the composer and once sent: its kind's tint holding a white icon. */
function FileTile({ kind }: { kind: string }) {
  const tile = tileOf(kind);
  const Icon = TILES[tile];
  return (
    <span className="file-tile" data-kind={tile} aria-hidden="true">
      <Icon />
    </span>
  );
}

/** The files shown as images, by extension, in the composer and once sent: a sent message keeps only paths. */
const IMAGE_EXTENSIONS = new Set(["PNG", "JPG", "JPEG", "GIF", "WEBP"]);

/** Whether a file, by its name, shows as an image's thumbnail rather than its kind's card. */
const isImageName = (name: string) => IMAGE_EXTENSIONS.has(kindOf(name));

/** A sent file's card: its kind's tile, its name and its kind. */
function SentFileCard({ name }: { name: string }) {
  const kind = kindOf(name);
  return (
    <li className="sent-file">
      <FileTile kind={kind} />
      <span className="sent-file-text">
        <span className="sent-file-name" title={name}>{name}</span>
        <span className="sent-file-kind">{kind}</span>
      </span>
    </li>
  );
}

/** The reason a failure carries, for the line that names it. */
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A sent image, as its square thumbnail from the short-lived URL `fileUrl` gives for its path; an empty thumbnail until
 * that URL comes, and without `fileUrl`. One whose URL fails, or that the browser won't show, is named with why in its
 * place, as a reply's image is.
 */
function SentImage({ path, name, fileUrl }: { path: string; name: string; fileUrl: ((path: string) => Promise<string>) | undefined }) {
  const [shown, setShown] = useState<{ path: string; url: string } | { path: string; error: string } | null>(null);
  useEffect(() => {
    if (!fileUrl) return;
    let current = true;
    // `fileUrl` takes a path as a reply's markdown names it, percent-encoded.
    fileUrl(encodeURI(path)).then(
      (url) => current && setShown({ path, url }),
      (error: unknown) => current && setShown({ path, error: reason(error) }),
    );
    return () => {
      current = false;
    };
  }, [path, fileUrl]);
  const now = shown?.path === path ? shown : null;
  if (now && "error" in now) {
    return (
      <li className="sent-file">
        <FileTile kind={kindOf(name)} />
        <span className="sent-file-error" role="alert">{`${name} could not load: ${now.error}`}</span>
      </li>
    );
  }
  return (
    <li className="image-thumb" title={name} aria-label={name}>
      {now && <img src={now.url} alt={name} onError={() => setShown({ path, error: "the browser could not show it" })} />}
    </li>
  );
}

/**
 * A sent message's files, as ChatGPT shows them above its bubble: an image as its thumbnail, from `fileUrl`, any other
 * file as a card of its kind's tile, its name and its kind.
 */
export function SentFileCards({ paths, fileUrl }: { paths: string[]; fileUrl?: ((path: string) => Promise<string>) | undefined }) {
  if (paths.length === 0) return null;
  return (
    <ul className="sent-files" aria-label="Attached files">
      {paths.map((path) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        return isImageName(name) ? <SentImage key={path} path={path} name={name} fileUrl={fileUrl} /> : <SentFileCard key={path} name={name} />;
      })}
    </ul>
  );
}

/** A local file's object URL while the component that shows it stays, revoked as it goes. */
function useObjectUrl(file: File): string | null {
  const [url, setUrl] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    const created = URL.createObjectURL(file);
    setUrl({ file, url: created });
    return () => URL.revokeObjectURL(created);
  }, [file]);
  return url?.file === file ? url.url : null;
}

type ChipProps = ComposerFile & { name: string; onRetry: (id: string) => void; onRemove: (id: string) => void };

/** The ring over an uploading image, filling clockwise from the top. */
function ProgressRing({ progress }: { progress: number }) {
  const length = 2 * Math.PI * 9;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="9" strokeDasharray={length} strokeDashoffset={length * (1 - progress)} />
    </svg>
  );
}

/**
 * An attached image, as ChatGPT shows one: its square thumbnail from the local file, a ring of its upload's progress
 * over it, or a red-ringed Retry once it failed (why, under the chips), and Remove on its corner. One the browser can't
 * show is `onBroken`, to take a file's chip.
 */
function ImageChip({ id, file, state, name, onRetry, onRemove, onBroken }: ChipProps & { onBroken: () => void }) {
  const url = useObjectUrl(file);
  return (
    <li className="image-thumb composer-image" data-status={state.status} title={name}>
      {url && <img src={url} alt={name} onError={onBroken} />}
      {state.status === "uploading" && (
        <span
          className="composer-image-overlay"
          role="progressbar"
          aria-label={`Uploading ${name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(state.progress * 100)}
        >
          <ProgressRing progress={state.progress} />
        </span>
      )}
      {state.status === "failed" && (
        <span className="composer-image-overlay">
          <button type="button" className="composer-image-retry" aria-label={`Retry ${name}`} onClick={() => onRetry(id)}>
            <RotateCw aria-hidden="true" />
          </button>
        </span>
      )}
      <button type="button" className="composer-image-remove" aria-label={`Remove ${name}`} onClick={() => onRemove(id)}>
        <X aria-hidden="true" />
      </button>
    </li>
  );
}

/** An attached file's chip: its kind's tile, its name over its upload's progress, its kind or why it failed, and Remove. */
function FileChip({ id, state, name, onRetry, onRemove }: ChipProps) {
  return (
    <li className="composer-file" data-status={state.status}>
      <FileTile kind={kindOf(name)} />
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
  );
}

/**
 * The attached files in the composer above its text: an image (by its name, as once sent) as its thumbnail, any other
 * file, or an image the browser can't show, as its chip; under them, one line for each thumbnail whose upload failed,
 * saying why.
 */
export function ComposerFileChips({ files, onRetry, onRemove }: { files: ComposerFile[]; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const named = files.map((entry) => {
    const name = entry.state.status === "uploaded" ? entry.state.path.slice(entry.state.path.lastIndexOf("/") + 1) : entry.file.name;
    return { ...entry, name, thumbnail: isImageName(entry.file.name) && !broken.has(entry.id) };
  });
  const failedThumbnails = named.flatMap((entry) => (entry.thumbnail && entry.state.status === "failed" ? [{ id: entry.id, line: `Couldn't upload ${entry.name}: ${entry.state.error}` }] : []));
  return (
    <>
      <ul className="composer-files" aria-label="Attached files">
        {named.map(({ thumbnail, ...entry }) =>
          thumbnail ? (
            <ImageChip key={entry.id} {...entry} onRetry={onRetry} onRemove={onRemove} onBroken={() => setBroken((current) => new Set(current).add(entry.id))} />
          ) : (
            <FileChip key={entry.id} {...entry} onRetry={onRetry} onRemove={onRemove} />
          ),
        )}
      </ul>
      {failedThumbnails.length > 0 && (
        <div className="composer-file-failures">
          {failedThumbnails.map(({ id, line }) => (
            <p key={id} role="alert" title={line}>{line}</p>
          ))}
        </div>
      )}
    </>
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
