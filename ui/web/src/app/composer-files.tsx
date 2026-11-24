"use client";

import { m as motionElement } from "motion/react";
import { Presence, presenceMotion, CollapseList, FadeItem, useInstant } from "./collapse";

import { useEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type RefObject } from "react";
import { cn } from "cn";
import { Attachment, AttachmentHoverCard, AttachmentHoverCardContent, AttachmentHoverCardTrigger, AttachmentInfo, AttachmentPreview, AttachmentRemove, Attachments, type AttachmentData } from "@/components/ui/attachments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fileExtension, FileTypeIcon, isImageName } from "../components/file-type-icon";
import { attachmentAccountEpoch, subscribeAttachmentAccount } from "../plugin/file-account";
import { baseOf, filesPath, type FilesPath } from "./files-path";

interface AttachmentStore {
  upload: (file: File, options: { onProgress: (fraction: number) => void; signal: AbortSignal }) => Promise<FilesPath>;
  discard: (path: FilesPath, epoch: string | null) => Promise<void>;
}

type ComposerFileState =
  | { status: "uploading"; progress: number }
  | { status: "uploaded"; path: FilesPath }
  | { status: "failed"; error: string; hidden?: true; undeletedPath?: FilesPath };

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
  sendable: boolean;
}


export const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

const unavailableAccountEpoch = Symbol("attachment account storage unavailable");

function probeAttachmentAccountEpoch(): string | null | typeof unavailableAccountEpoch {
  try {
    return attachmentAccountEpoch();
  } catch {
    // A failed storage probe disables attachment sending; uploads report the storage failure on their chip.
    return unavailableAccountEpoch;
  }
}

export function useComposerFiles({ upload, discard }: AttachmentStore, accountId: string | undefined, onAdd?: () => void): ComposerFiles {
  const epoch = useSyncExternalStore(subscribeAttachmentAccount, probeAttachmentAccountEpoch, () => null);
  const [state, setState] = useState({ accountId, epoch, files: [] as ComposerFile[] });
  const files = state.files;
  const setFiles = (change: (current: ComposerFile[]) => ComposerFile[]) => setState((current) => ({ ...current, files: change(current.files) }));
  const uploads = useRef(new Map<string, AbortController>());
  const takenBack = useRef(new Set<string>());
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
      settle(id, { status: "failed", error: `The agent can't read hidden files like ${file.name}. Rename it without the leading dot.`, hidden: true });
      return;
    }
    const controller = new AbortController();
    uploads.current.set(id, controller);
    settle(id, { status: "uploading", progress: 0 });
    void upload(file, { onProgress: (progress) => settle(id, { status: "uploading", progress }), signal: controller.signal }).then(
      (path) => (takenBack.current.has(id) ? deleteUpload(id, file, path) : settle(id, { status: "uploaded", path })),
      (error: Error) => {
        if (!controller.signal.aborted) settle(id, { status: "failed", error: error.message });
      },
    ).finally(() => uploads.current.delete(id));
  };
  const abort = (id: string) => {
    uploads.current.get(id)?.abort();
    uploads.current.delete(id);
  };
  const deleteUpload = (id: string, file: File, path: FilesPath) => {
    const owner = { accountId: state.accountId, epoch: state.epoch };
    const deleting = typeof owner.epoch === "symbol" ? Promise.reject(new Error("Account storage is unavailable")) : discard(path, owner.epoch);
    deleting.catch((failure: unknown) => {
      const error = `Couldn't remove ${baseOf(path)} from Files: ${reason(failure)}`;
      const undeleted: ComposerFile = { id, file, state: { status: "failed", error, undeletedPath: path } };
      setState((current) => (current.accountId === owner.accountId && current.epoch === owner.epoch ? { ...current, files: [...current.files, undeleted] } : current));
    });
  };
  const remove = ({ id, file, state }: ComposerFile) => {
    takenBack.current.add(id);
    abort(id);
    setFiles((current) => current.filter((entry) => entry.id !== id));
    if (state.status === "uploaded") deleteUpload(id, file, state.path);
  };
  return {
    files,
    add: (list) => {
      onAdd?.();
      const added = [...list].map((file): ComposerFile => ({ id: String((nextId.current += 1)), file, state: { status: "uploading", progress: 0 } }));
      setFiles((current) => [...current, ...added]);
      for (const { id, file } of added) start(id, file);
    },
    retry: (id) => {
      const entry = files.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`No attached file ${id} to retry`);
      if (entry.state.status === "failed" && entry.state.undeletedPath !== undefined) {
        remove(entry);
        deleteUpload(id, entry.file, entry.state.undeletedPath);
      } else start(id, entry.file);
    },
    remove: (id) => {
      const entry = files.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`No attached file ${id} to remove`);
      remove(entry);
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

export function messageWithFiles(text: string, paths: readonly FilesPath[]): string {
  if (paths.length === 0) return text;
  return `${text}\n\nAttached files:\n${paths.map((path) => `- ${path}`).join("\n")}`;
}

export function sentFilesOf(message: string): { text: string; paths: FilesPath[] } {
  const match = /^([\s\S]*)\n\nAttached files:\n(- .*(?:\n- .*)*)$/.exec(message);
  if (!match) return { text: message, paths: [] };
  return { text: match[1] ?? "", paths: (match[2] ?? "").split("\n").map((line) => filesPath(line.slice(2))) };
}

function kindOf(name: string): string {
  return fileExtension(name).toUpperCase() || "File";
}

function FileIconBox({ name }: { name: string }) {
  return (
    <span className="file-icon">
      <FileTypeIcon name={name} />
    </span>
  );
}

export function FileFace({ name }: { name: string }) {
  return (
    <>
      <FileIconBox name={name} />
      <span className="sent-file-text">
        <span className="sent-file-name" title={name}>{name}</span>
        <span className="sent-file-kind">{kindOf(name)}</span>
      </span>
    </>
  );
}

/**
 * A sent image, as its square thumbnail from the short-lived URL `fileUrl` gives for its path; an empty thumbnail until
 * that URL comes, and without `fileUrl`. One whose URL fails, or that the browser won't show, is named with why in its
 * place, as a reply's image is.
 */
function SentImage({ path, name, fileUrl }: { path: FilesPath; name: string; fileUrl: ((path: FilesPath) => Promise<string>) | undefined }) {
  const [shown, setShown] = useState<{ path: string; url: string } | { path: string; error: string } | null>(null);
  useEffect(() => {
    if (!fileUrl) return;
    let current = true;
    fileUrl(path).then(
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
        <FileIconBox name={name} />
        <span className="sent-file-error" role="alert">{`${name} could not load: ${now.error}`}</span>
      </li>
    );
  }
  return (
    <li className="image-thumb" title={name} aria-label={name}>
      <Presence>{now && <motionElement.img {...presenceMotion} src={now.url} alt={name} onError={() => setShown({ path, error: "the browser could not show it" })} />}</Presence>
    </li>
  );
}

export function SentFileCards({ paths, fileUrl }: { paths: FilesPath[]; fileUrl?: ((path: FilesPath) => Promise<string>) | undefined }) {
  if (paths.length === 0) return null;
  return (
    <ul className="sent-files" aria-label="Attached files">
      {paths.map((path) => {
        const name = baseOf(path);
        return isImageName(name) ? <SentImage key={path} path={path} name={name} fileUrl={fileUrl} /> : <li key={path} className="sent-file"><FileFace name={name} /></li>;
      })}
    </ul>
  );
}

/** A local object URL for `file`, revoked as it goes; none while `file` is null. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) return;
    const created = URL.createObjectURL(file);
    setUrl({ file, url: created });
    return () => URL.revokeObjectURL(created);
  }, [file]);
  return file && url?.file === file ? url.url : null;
}

type ChipProps = ComposerFile & { name: string; onRetry: (id: string) => void; onRemove: (id: string) => void };

const uploading = (name: string, progress: number) =>
  ({
    role: "progressbar",
    "aria-label": `Uploading ${name}`,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": Math.round(progress * 100),
  }) as const;

/**
 * Remove shows on hover or keyboard focus, as stock's tile does; with no hover (phones), always. Tailwind's `hover`
 * variants apply only where the device can hover.
 */
const REVEAL_REMOVE = "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

/** The stock Attachment's data for an attached file: its picture by `url`, or none for its type's icon. */
const attachmentOf = (id: string, name: string, file: File, url: string | null): AttachmentData => ({
  id,
  type: "file",
  filename: name,
  mediaType: url ? file.type : "",
  url: url ?? "",
});

/** An attached image, as stock's square tile from the local file: it fades while it uploads. */
function ImageTile({ id, file, state, name, onRemove, onBroken }: Omit<ChipProps, "onRetry"> & { onBroken: () => void }) {
  const url = useObjectUrl(file);
  return (
    <FadeItem className="composer-image" data-status={state.status} title={name}>
      <Attachments variant="grid" className="contents">
        <Attachment data={attachmentOf(id, name, file, url)} onRemove={() => onRemove(id)} onError={onBroken} className={cn("size-14", state.status === "uploading" && "opacity-50")}>
          <AttachmentPreview />
          <span className="sr-only" {...(state.status === "uploading" ? uploading(name, state.progress) : {})} />
          <AttachmentRemove label={`Remove ${name}`} className={REVEAL_REMOVE} />
        </Attachment>
      </Attachments>
    </FadeItem>
  );
}

/** A card's second line: its kind, its upload's progress, or, in red, why it failed, with Retry where Retry helps. */
function SecondLine({ id, state, name, onRetry }: Omit<ChipProps, "file" | "onRemove">) {
  if (state.status === "uploading") {
    return <span className="block truncate text-muted-foreground text-xs" {...uploading(name, state.progress)}>{`Uploading… ${Math.round(state.progress * 100)}%`}</span>;
  }
  if (state.status === "uploaded") return <span className="block truncate text-muted-foreground text-xs">{kindOf(name)}</span>;
  const said = state.hidden ? "Hidden file: rename it" : state.undeletedPath === undefined ? "Upload failed" : "Remove failed";
  return (
    <span className="flex min-w-0 text-destructive text-xs">
      {/* The full reason: in stock's hover card on hover, and in the alert for a screen reader. Only it ellipsizes; Retry stays whole. */}
      <AttachmentHoverCard>
        <AttachmentHoverCardTrigger render={<span role="alert" className="min-w-0 truncate" />}>
          {said}
          <span className="sr-only">{`: ${state.error}`}</span>
        </AttachmentHoverCardTrigger>
        <AttachmentHoverCardContent>{state.error}</AttachmentHoverCardContent>
      </AttachmentHoverCard>
      {/* A hidden file needs renaming, not Retry. */}
      <span className="shrink-0 whitespace-pre" hidden={state.hidden}>
        {" · "}
        <Button type="button" variant="link" size="xs" className="h-auto p-0 text-destructive underline" onClick={() => onRetry(id)}>Retry</Button>
      </span>
    </span>
  );
}

/** An attached file, as stock's list card: our type icon, or a failed image's picture, then its name over its second line. */
function FileCard({ id, file, state, name, picture, onRetry, onRemove, onBroken }: ChipProps & { picture: boolean; onBroken: () => void }) {
  const url = useObjectUrl(picture ? file : null);
  return (
    <FadeItem className="composer-file" data-status={state.status}>
      <Attachments variant="list" className="contents">
        <Attachment data={attachmentOf(id, name, file, url)} onRemove={() => onRemove(id)} onError={onBroken} className={cn("p-2.5 text-sm", state.status === "failed" && "border-destructive", state.status === "uploading" && "opacity-50")}>
          <AttachmentPreview fallbackIcon={<FileIconBox name={name} />} className="size-10 bg-transparent" />
          <div className="min-w-0 flex-1">
            <AttachmentInfo title={name} />
            <SecondLine id={id} state={state} name={name} onRetry={onRetry} />
          </div>
          <AttachmentRemove label={`Remove ${name}`} className={REVEAL_REMOVE} />
        </Attachment>
      </Attachments>
    </FadeItem>
  );
}

/**
 * The attached files in the composer above its text, on stock AI Elements Attachments: an image (by its name, as once
 * sent) as its tile until its upload fails, then as a card with its picture; any other file, or an image the browser
 * can't show, as a card with its type's icon.
 */
export function ComposerFileChips({ files, onRetry, onRemove }: { files: ComposerFile[]; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const named = files.map((entry) => {
    const path = entry.state.status === "uploaded" ? entry.state.path : entry.state.status === "failed" ? entry.state.undeletedPath : undefined;
    const name = path === undefined ? entry.file.name : baseOf(path);
    return { ...entry, name, picture: isImageName(entry.file.name) && !broken.has(entry.id) };
  });
  // The list outlives its last chip while that chip fades out, then leaves, and the composer shrinks after it.
  const instant = useInstant();
  const [listed, setListed] = useState(false);
  if (files.length > 0 && !listed) setListed(true);
  const shown = files.length > 0 || (listed && !instant);
  return (
    <Presence>{shown && <motionElement.ul {...presenceMotion} className="composer-files" aria-label="Attached files">
      {/* The list mounts with its first chip, which fades in as any later one does. */}
      <CollapseList initial onExitComplete={() => setListed(false)}>
        {named.map(({ picture, ...entry }) => {
          const onBroken = () => setBroken((current) => new Set(current).add(entry.id));
          return picture && entry.state.status !== "failed" ? (
            <ImageTile key={entry.id} {...entry} onRemove={onRemove} onBroken={onBroken} />
          ) : (
            <FileCard key={entry.id} {...entry} picture={picture} onRetry={onRetry} onRemove={onRemove} onBroken={onBroken} />
          );
        })}
      </CollapseList>
    </motionElement.ul>}</Presence>
  );
}

/** The file picker the composer's + opens, hidden. */
export function ComposerFilePicker({ picker, add }: { picker: RefObject<HTMLInputElement | null>; add: ComposerFiles["add"] }) {
  return (
    <Input
      ref={picker}
      type="file"
      multiple
      hidden
      onChange={(event) => {
        add([...(event.currentTarget.files ?? [])]);
        // The same file can be picked again, as after removing it.
        event.currentTarget.value = "";
      }}
    />
  );
}
