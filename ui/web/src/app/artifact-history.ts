import type { ArtifactVersions } from "./artifact-versions";

/** One stored version of an Artifact: who made it and when Files wrote it. */
export type HistoryVersion = { version: number; author: "agent" | "user"; at: Date };

/** Every stored version of an Artifact up to `newest`, newest first, each with the author its record names. */
export async function historyOf(versions: ArtifactVersions, newest: number): Promise<HistoryVersion[]> {
  const stored = (await versions.list()).filter(({ version }) => version <= newest);
  return Promise.all(stored.map(async ({ version, at }) => ({ version, at, author: (await versions.read(version)).author })));
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
