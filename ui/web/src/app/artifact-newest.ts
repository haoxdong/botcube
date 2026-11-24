"use client";

import { useEffect, useRef, useState } from "react";

import { artifactVersions, type FilesReader } from "./artifact-versions";
import { reason } from "./composer-files";
import type { FilesPath } from "./files-path";

/** An Artifact Version as the panel knows it: `path` is where Files stores it. */
type Known = { id: FilesPath; version: number; path: FilesPath };

/**
 * The Artifact's newest version in Files, from a version the chat has seen: a User's save is no message, so a reloaded
 * chat knows only the versions published in it.
 */
export async function newestInFiles<T extends Known>(known: T, files?: FilesReader): Promise<T> {
  const versions = artifactVersions(known.id, files);
  const newest = await versions.newest();
  if (newest === undefined || newest.version <= known.version) return known;
  const { author, title, description } = await versions.read(newest.version);
  return { ...known, author, title, description, version: newest.version, path: newest.path };
}

/**
 * Opening an Artifact (`id`) asks Files for its newest version and shows that; until it answers, the panel shows
 * `known`, the newest the chat has seen. Returns why Files couldn't say, by Artifact id.
 */
export function useNewestInFiles<T extends Known>(
  id: string | undefined, known: T | undefined, look: (known: T) => Promise<T>, seen: (found: T) => void,
) {
  const [failures, setFailures] = useState<Readonly<Record<string, string | undefined>>>({});
  const latest = useRef(known);
  latest.current = known;
  const knows = known !== undefined;
  useEffect(() => {
    const from = latest.current;
    if (id === undefined || from === undefined) return;
    let current = true;
    const fail = (failure: string | undefined) => setFailures((before) => before[id] === failure ? before : { ...before, [id]: failure });
    look(from).then(
      (found) => {
        if (!current) return;
        seen(found);
        fail(undefined);
      },
      (error: unknown) => {
        if (current) fail(`Couldn't look for a newer version in Files: ${reason(error)}`);
      },
    );
    return () => {
      current = false;
    };
  }, [id, knows, look, seen]);
  return failures;
}
