"use client";

import type { ComponentProps, ReactNode, Ref } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import { Fades } from "./motion";

type LineProps = ComponentProps<"div"> & {
  /** An error is red and an alert; a notice is muted and a status, unless `role` says otherwise. */
  tone?: "error" | "notice";
};

/**
 * Every error and notice line in the web app: stock Alert, unedited, as one line of small text in the place it reports on.
 * Where it sits (margins, centring, a box around it) is its screen's, by `className`.
 */
export function AlertLine({ tone = "error", className, ...line }: LineProps) {
  const error = tone === "error";
  return (
    <Alert
      variant={error ? "destructive" : "default"}
      role={error ? "alert" : "status"}
      className={[
        "block w-auto rounded-none border-0 bg-transparent p-0 text-(length:--font-small)",
        error ? "" : "text-(--color-text-muted)",
        className ?? "",
      ].join(" ")}
      {...line}
    />
  );
}

/**
 * An error line inside a sentence, as a reply's paragraph holds its link's could-not-download: a paragraph can't hold
 * stock Alert's div, so this is the same small red alert as a span.
 */
export function InlineAlertLine({ className, ...line }: ComponentProps<"span">) {
  return <span role="alert" className={["text-(--color-red) text-(length:--font-small)", className ?? ""].join(" ")} {...line} />;
}

/** "Couldn't open" an Artifact, in its panel; it takes `ref` so a Fades around it fades it. */
export function CouldntOpen({ title, why, ref }: { title: string; why: ReactNode; ref?: Ref<HTMLDivElement> }) {
  return <AlertLine ref={ref} className="artifact-refused">Couldn&apos;t open {title}: {why}</AlertLine>;
}

/** That a newer version arrived over the User's edits, which are kept, with the way to drop them for it. */
export function NewerVersion({ newest, edited, onDiscard, disabled = false, ref }: { newest: number; edited: number; onDiscard: () => void; disabled?: boolean; ref?: Ref<HTMLDivElement> }) {
  return (
    <AlertLine ref={ref} tone="notice" className="artifact-edit-newer">
      <span>Version {newest} arrived while you edited version {edited}. Your edits are kept.</span>
      <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onDiscard}>Discard edits and open version {newest}</Button>
    </AlertLine>
  );
}

/** Why an edit could not save, a line each, under the edit bar. */
export function EditFailures({ failures }: { failures: readonly string[] }) {
  return (
    <Fades>{failures.map((failure) => (
      <AlertLine key={failure} className="artifact-refused artifact-edit-failure">{failure}</AlertLine>
    ))}</Fades>
  );
}
