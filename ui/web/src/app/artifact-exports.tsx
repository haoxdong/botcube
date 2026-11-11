"use client";

import { m as motionElement } from "framer-motion";
import { useState, type ReactNode } from "react";

import { type ArtifactVersion, type Export, type ExportTarget, type OnScreen } from "./artifact-viewer";
import { Presence, presenceMotion } from "./collapse";
import { reason } from "./composer-files";

/**
 * A type's Exports as the panel head's Download buttons, and the alert a failed one shows, which names what failed and
 * offers the Export's `instead`, the type's PDF, when it has one. The Exports are made from the stored version on screen: `newest` (null for a
 * Source the agent is writing), unless its Viewer `shows` another. While the User has unsaved edits, a note by the
 * buttons says which version the stored Exports make.
 */
export function useExports(exports: readonly Export[], { newest, ...artifact }: Omit<ExportTarget, "onScreen"> & { newest: ArtifactVersion | null }): {
  buttons: ReactNode; failure: ReactNode; shows: (onScreen: OnScreen) => void;
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
    buttons: (
      <>
        <Presence>{onScreen?.unsaved === true && stored.length > 0 && (
          <motionElement.span {...presenceMotion} role="note" className="artifact-export-note">
            {capitalized(stored.join(" and "))} {stored.length > 1 ? "are" : "is"} version {onScreen.version.version}, without your unsaved edits
          </motionElement.span>
        )}</Presence>
        {exports.map((exported) => (
          <button key={exported.label} type="button" className="header-btn" aria-label={exported.label} title={exported.label}
            onClick={() => download(exported)}><exported.Icon aria-hidden /></button>
        ))}
      </>
    ),
    failure: (
      <Refusal message={failure && `Couldn't make ${failure.exported.failed}: ${failure.reason}.`} keyed>
        {" "}<button type="button" className="artifact-instead" hidden={instead === undefined} onClick={() => instead && download(instead)}>{instead?.label}</button>
      </Refusal>
    ),
    shows,
  };
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Why the panel refused something, faded in and out; `keyed` replays the fade when the message changes. */
export function Refusal({ message, keyed = false, children }: { message: string | null; keyed?: boolean; children?: ReactNode }) {
  return (
    <Presence>{message !== null && (
      <motionElement.p key={keyed ? message : undefined} {...presenceMotion} role="alert" className="artifact-refused">{message}{children}</motionElement.p>
    )}</Presence>
  );
}
