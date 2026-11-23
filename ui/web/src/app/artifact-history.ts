import { readRecord } from "botcube-artifact-check/record";

import type { FileEntry } from "../computer/files-service";

/** One stored version of an Artifact: who made it and when its record was written. */
export type HistoryVersion = { version: number; author: "agent" | "user"; at: Date };

/**
 * Every stored version of the Artifact `id` up to `newest`, newest first: each `<n>.json` record beside its version
 * (`artifacts/<Source>.versions/<n>.json`, the harness's layout) names its author, and Files dates it.
 */
export async function historyOf(id: string, newest: number, files: readonly FileEntry[], read: (path: string) => Promise<string>): Promise<HistoryVersion[]> {
  const folder = `artifacts${id}.versions/`;
  const records = files.flatMap(({ name, lastModified }) => {
    if (!name.startsWith(folder)) return [];
    const number = /^(\d+)\.json$/.exec(name.slice(folder.length))?.[1];
    return number === undefined || Number(number) > newest ? [] : [{ name, version: Number(number), at: new Date(lastModified) }];
  });
  const history = await Promise.all(records.map(async ({ name, version, at }) => ({ version, at, author: readRecord(await read(`/${name}`)).author })));
  return history.sort((a, b) => b.version - a.version);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const midnight = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/** "Today", "Yesterday", else the date ("Nov 21"), with its year when it is not this year's. */
export function dayOf(at: Date, now: Date): string {
  const days = Math.round((midnight(now) - midnight(at)) / DAY_MS);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const year = at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" } as const;
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", ...year });
}

export const timeOf = (at: Date) => at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** How long ago, short: "just now", "5m ago", "2h ago", "3d ago". */
export function agoOf(at: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (24 * 60))}d ago`;
}

/** The versions under their day's label, in the order given. */
export function byDay(history: readonly HistoryVersion[], now: Date): { day: string; versions: HistoryVersion[] }[] {
  const days: { day: string; versions: HistoryVersion[] }[] = [];
  for (const version of history) {
    const day = dayOf(version.at, now);
    const last = days.at(-1);
    if (last?.day === day) last.versions.push(version);
    else days.push({ day, versions: [version] });
  }
  return days;
}
