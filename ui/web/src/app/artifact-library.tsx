"use client";

import { useEffect, useState } from "react";

import { listArtifacts } from "./artifact-versions";
import { ArtifactFace } from "./artifact-face";
import type { Published } from "./artifact-published";
import { reason } from "./composer-files";
import { LoadFailed, LoadingSkeleton } from "./load-state";
import { Arrives } from "./motion";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Item } from "@/components/ui/item";

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
    <Arrives state={shown === null ? "loading" : "error" in shown ? "error" : shown.artifacts.length === 0 ? "empty" : "list"} waiting={shown === null}>
    {shown === null ? <LoadingSkeleton label="Artifacts" /> : "error" in shown ? <LoadFailed error={shown.error} onRetry={() => retry((value) => value + 1)} action="Try again" /> : shown.artifacts.length === 0 ? <Empty><EmptyDescription>No Artifacts yet. Artifacts you make in chat appear here.</EmptyDescription></Empty> : (
      <ul aria-label="Artifacts, newest first" className="m-0 flex max-w-2xl list-none flex-col gap-1 p-0">
        {shown.artifacts.map((artifact) => <li key={artifact.id}>
          <Item render={<button type="button" />} className="artifact-row flex-nowrap cursor-pointer gap-3 rounded-(--radius-lg) border-0 p-2 text-left text-[length:inherit] hover:bg-(--color-fill)" onClick={() => onSelect(artifact)}>
            <ArtifactFace artifact={artifact} />
          </Item>
        </li>)}
      </ul>
    )}
    </Arrives>
  </div>;
}
