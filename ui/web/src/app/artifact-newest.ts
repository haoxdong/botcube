"use client";

import { readRecord, type VersionRecord } from "botcube-artifact-check/record";
import { useEffect, useRef, useState } from "react";

import { HttpStatusError } from "../computer/files-upload";
import { fileUrl } from "./artifact-files";
import { reason } from "./composer-files";

/** The record of the version stored at `path`: `<n>.json` beside it. */
export async function recordOf(path: string, read: (path: string) => Promise<string>): Promise<VersionRecord> {
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  const number = /^\d+/.exec(path.slice(folder.length))?.[0];
  if (number === undefined) throw new Error(`${path} is not a stored version`);
  return readRecord(await read(`${folder}${number}.json`));
}

/** An Artifact Version as the panel knows it: `path` is where Files stores it. */
type Known = { version: number; path: string };

/** Whether Files holds `path`: a 404 says it doesn't, and any other failure throws. */
async function inFiles(path: string): Promise<boolean> {
  try {
    await fileUrl(path);
    return true;
  } catch (error) {
    if (error instanceof HttpStatusError && error.status === 404) return false;
    throw error;
  }
}

/**
 * The Artifact's newest version in Files, from a version the chat has seen: a User's save is no message, so a reloaded
 * chat knows only the versions published in it. A version counts once `stored`, the file under its path that its type
 * writes last, is there; its record is written before it.
 */
export async function newestInFiles<T extends Known>(known: T, stored: string, read: (path: string) => Promise<string>): Promise<T> {
  const folder = known.path.slice(0, known.path.lastIndexOf("/") + 1);
  const suffix = known.path.slice(folder.length).replace(/^\d+/, "");
  let version = known.version;
  // eslint-disable-next-line no-await-in-loop -- each version is looked for only once the one before it is found
  while (await inFiles(`${folder}${version + 1}${suffix}${stored}`)) version += 1;
  if (version === known.version) return known;
  const path = `${folder}${version}${suffix}`;
  const { author, title, description } = await recordOf(path, read);
  return { ...known, author, title, description, version, path };
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
