"use client";

import "./artifact-library.css";

import { useEffect, useState } from "react";

import { listArtifacts } from "./artifact-catalog";
import { ArtifactFace } from "./artifact-face";
import type { Published } from "./artifact-published";
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
    <p className="plugins-intro">Your Artifacts, newest first.</p>
    {shown === null ? <p role="status">Loading Artifacts…</p> : "error" in shown ? <>
      <p role="alert">{shown.error}</p>
      <button type="button" className="btn" onClick={() => retry((value) => value + 1)}>Try again</button>
    </> : shown.artifacts.length === 0 ? <p>No Artifacts yet. Artifacts you make in chat appear here.</p> : (
      <ul aria-label="Artifacts, newest first" className="artifact-library-list">
        {shown.artifacts.map((artifact) => <li key={artifact.id}>
          <button type="button" className="sent-file artifact-card" onClick={() => onSelect(artifact)}><ArtifactFace artifact={artifact} /></button>
        </li>)}
      </ul>
    )}
  </div>;
}
