import { PrinterIcon, type LucideIcon } from "lucide-react";
import type { ComponentType, RefObject } from "react";

/** An Artifact Version as the `Artifact` tool describes it. */
export type ArtifactVersion = { id: string; title: string; version: number; path: string };

/** A User's save as the Chat Service takes it: the edited files of `version`, by their path in the Source. */
export type ArtifactEdit = { id: string; version: number; files: Record<string, string> };

/** The stored version a Viewer shows, and whether the User has edits to it they have not saved. */
export type OnScreen = { version: ArtifactVersion; unsaved: boolean };

/**
 * What the panel gives a type's Viewer: the Artifact's newest version, the readers of its files (as text, and as bytes),
 * the save, which resolves once the edit is the Artifact's next version, and `shows`, which the Viewer tells what it
 * shows.
 */
export type ViewerProps = {
  artifact: ArtifactVersion;
  read: (path: string) => Promise<string>;
  readBytes: (path: string) => Promise<ArrayBuffer>;
  save: (edit: ArtifactEdit) => Promise<void>;
  frame: RefObject<HTMLIFrameElement | null>;
  shows: (onScreen: OnScreen) => void;
};

/**
 * What an Export gets of the Artifact on screen: its title, the frame that shows it, the readers of its files, and the
 * stored version the Viewer shows, or null for a Source the agent is still writing.
 */
export type ExportTarget = {
  title: string;
  frame: RefObject<HTMLIFrameElement | null>;
  read: (path: string) => Promise<string>;
  readBytes: (path: string) => Promise<ArrayBuffer>;
  onScreen: OnScreen | null;
};

/**
 * A Download button in the panel head. `run` rejects with what failed; the panel then shows it, with `failed` naming
 * what could not be made, and offers `instead` (the type's PDF, ADR 0087) when the type has one. A `stored` Export is
 * made from the stored version on screen, so it leaves out the User's unsaved edits; any other prints what is shown.
 */
export type Export = {
  label: string;
  Icon: LucideIcon;
  failed: string;
  stored: boolean;
  run: (target: ExportTarget) => void | Promise<void>;
  instead?: Export;
};

/** The stored version a stored Export is made from; one the agent is still writing has none yet, and is refused. */
export function storedVersion({ onScreen }: ExportTarget, what: string): ArtifactVersion {
  if (onScreen === null) throw new Error(`${what} is still being written; it downloads once it is published`);
  return onScreen.version;
}

/** How long a saved file's URL stays live: a browser may read it after the click returns. */
const SAVE_URL_MS = 10_000;

/** Hands the browser an Export's file to save as `name`, with the characters a file name can't hold replaced. */
export function saveFile(blob: Blob, name: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name.replace(/[/\\:*?"<>|]/g, "-");
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), SAVE_URL_MS);
}

/** A one-file Source as the agent writes it: its text so far, `complete` once its file is written. */
export type PreviewProps = { title: string; text: string | null; complete: boolean; frame: RefObject<HTMLIFrameElement | null> };

/** The one-file Sources of a type the panel follows while the agent writes them, and how it previews one. */
export type Writes = { matches: (path: string) => boolean; Preview: ComponentType<PreviewProps> };

/**
 * A type's PDF (ADR 0087), which `prints` has the browser print: `stored` when it prints the stored version on
 * screen, else what the panel shows, unsaved edits included.
 */
export const pdfOf = (prints: Export["run"], stored: boolean): Export => ({
  label: "Download as PDF", Icon: PrinterIcon, failed: "the PDF", stored, run: prints,
});

/** A framed type's PDF: the frame prints its own page, since the app cannot reach into a frame of another origin. */
export const PDF = pdfOf(({ frame }) => frame.current?.contentWindow?.postMessage({ type: "artifact-print" }, "*"), false);

/** An Artifact Type as the panel draws it. */
export type ArtifactType = {
  label: string;
  /** Its Viewer, which edits it in place when the type is edited. */
  Viewer: ComponentType<ViewerProps>;
  exports: readonly Export[];
  /** The file a stored version holds under its path (a one-file version is that file). */
  stored: string;
  /**
   * The one-file Sources the panel previews as the agent writes them; a deck's files preview as the deck, and any other
   * write previews as a page.
   */
  writes: Writes | null;
};
