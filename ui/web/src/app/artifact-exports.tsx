"use client";

import { DownloadIcon } from "lucide-react";
import { Fades } from "./motion";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { AlertLine } from "./alert-line";
import { type ArtifactVersion, type Export, type ExportTarget, type OnScreen } from "./artifact-viewer";
import { reason } from "./composer-files";

/**
 * A type's Exports as the panel head's Download menu, one item per format even when the type has one, and the alert a failed one shows, which names what failed and
 * offers the Export's `instead`, the type's PDF, when it has one. The Exports are made from the stored version on screen: `newest` (null for a
 * Source the agent is writing), unless its Viewer `shows` another. While the User has unsaved edits, a note by the
 * menu says which version the stored Exports make.
 */
export function useExports(exports: readonly Export[], { newest, ...artifact }: Omit<ExportTarget, "onScreen"> & { newest: ArtifactVersion | null }): {
  menu: ReactNode; failure: ReactNode; shows: (onScreen: OnScreen) => void;
} {
  const [reported, shows] = useState<OnScreen | null>(null);
  const onScreen = newest && (reported?.version.id === newest.id ? reported : { version: newest, unsaved: false });
  const target: ExportTarget = { ...artifact, onScreen };
  const [failure, setFailure] = useState<{ exported: Export; reason: string } | null>(null);
  const download = (exported: Export) => {
    setFailure(null);
    void (async () => exported.run(target))().catch((error: unknown) => setFailure({ exported, reason: reason(error) }));
  };
  const instead = failure?.exported.instead;
  const stored = exports.filter(({ stored }) => stored).map(({ failed }) => failed);
  return {
    menu: (
      <>
        <Fades>{onScreen?.unsaved === true && stored.length > 0 && (
          <AlertLine tone="notice" role="note" className="artifact-export-note">
            {capitalized(stored.join(" and "))} {stored.length > 1 ? "are" : "is"} version {onScreen.version.version}, without your unsaved edits
          </AlertLine>
        )}</Fades>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger render={<DropdownMenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label="Download" />} />}>
              <DownloadIcon aria-hidden />
            </TooltipTrigger>
            <TooltipContent>Download</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="artifact-download-menu w-auto">
            {exports.map((exported) => (
              <DropdownMenuItem key={exported.label} onClick={() => download(exported)}><exported.Icon aria-hidden />{exported.label}</DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    ),
    failure: (
      <Refusal message={failure && `Couldn't make ${failure.exported.failed}: ${failure.reason}.`} keyed>
        {" "}<Button type="button" variant="link" hidden={instead === undefined} onClick={() => instead && download(instead)}>Download as {instead?.label}</Button>
      </Refusal>
    ),
    shows,
  };
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Why the panel refused something, faded in and out; `keyed` replays the fade when the message changes. */
export function Refusal({ message, keyed = false, children }: { message: string | null; keyed?: boolean; children?: ReactNode }) {
  return (
    <Fades>{message !== null && (
      <AlertLine key={keyed ? message : undefined} className="artifact-refused">{message}{children}</AlertLine>
    )}</Fades>
  );
}
