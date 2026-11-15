"use client";

import { useEffect, useState } from "react";

import { listArtifacts } from "./artifact-catalog";
import { TYPES } from "./artifact-types";
import type { Published } from "./artifact-published";
import { Swap } from "./collapse";
import { reason } from "./composer-files";

type Result = { accountId: string | undefined } & ({ artifacts: Published[] } | { error: string });

export function ArtifactLibrary({ accountId, onSelect }: { accountId: string | undefined; onSelect: (artifact: Published) => void }) {
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    let current = true;
    setResult(null);
    listArtifacts().then(
      (artifacts) => { if (current) setResult({ accountId, artifacts }); },
      (error: unknown) => { if (current) setResult({ accountId, error: reason(error) }); },
    );
    return () => { current = false; };
  }, [accountId, attempt]);
  const shown = result?.accountId === accountId ? result : null;
  return <div className="plugins artifact-library">
    <h1 className="plugins-title">Artifacts</h1>
    <Swap key={accountId} state={shown === null ? "loading" : "error" in shown ? "error" : shown.artifacts.length === 0 ? "empty" : "list"}>
    {shown === null ? <p role="status">Loading Artifacts…</p> : "error" in shown ? <>
      <p role="alert">{shown.error}</p>
      <button type="button" className="btn" onClick={() => retry((value) => value + 1)}>Try again</button>
    </> : shown.artifacts.length === 0 ? <p>No Artifacts yet. Artifacts you make in chat appear here.</p> : (
      <ul aria-label="Artifacts, newest first" className="m-0 grid max-w-4xl list-none grid-cols-2 gap-3 p-0 sm:grid-cols-3">
        {shown.artifacts.map((artifact) => {
          const { Icon, tint, ink } = TYPES[artifact.type ?? "page"];
          return <li key={artifact.id}>
            <button type="button" className="flex w-full cursor-pointer flex-col overflow-hidden rounded-(--radius-lg) border border-line bg-(--color-white) text-left" onClick={() => onSelect(artifact)}>
              <span className={`flex h-24 w-full items-center justify-center ${tint}`}><Icon aria-hidden className={`file-icon size-7 ${ink}`} /></span>
              <span className="sent-file-name w-full truncate p-3">{artifact.title}</span>
            </button>
          </li>;
        })}
      </ul>
    )}
    </Swap>
  </div>;
}
