// An Artifact Version's record, `<n>.json` beside it in the version store, as the harness's `Artifact` tool writes it
// (botcube_harness_deepagents/artifact.py) and the Chat Service's save writes a User's. Its `imports` list the store's
// copy of each File the Source names (kept_files.py): a Sheet's import steps, an Email's attachments. Browser-safe: the
// panel reads a version's record through it.
import { z } from 'zod';

const Imported = z.object({ edit: z.number().int(), from: z.string(), path: z.string() });

const VersionRecord = z.object({
  author: z.enum(['agent', 'user']),
  title: z.string(),
  description: z.string(),
  imports: z.array(Imported).optional(),
});

/** The record in `text`; throws naming what is wrong when it is not one. */
export const readRecord = (text) => VersionRecord.parse(JSON.parse(text));
