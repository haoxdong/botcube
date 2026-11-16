import { createContext } from "react";
import { z } from "zod";

export const Published = z.object({
  id: z.string(),
  type: z.enum(["slides", "doc", "sheet", "email"]).nullable(),
  title: z.string(),
  description: z.string(),
  version: z.number(),
  path: z.string(),
  author: z.enum(["agent", "user"]).optional(),
});
export type Published = z.infer<typeof Published>;

/** A refused publish's result is the tool's error text, never JSON; a JSON result that is no Artifact throws. */
export function publishedOf(result: string): Published | null {
  let json: unknown;
  try {
    json = JSON.parse(result);
  } catch {
    return null;
  }
  return Published.parse(json);
}

/** The Artifacts a Turn published, shown in its answer's bubble under the words. */
export const AnswerCards = createContext<readonly Published[]>([]);
