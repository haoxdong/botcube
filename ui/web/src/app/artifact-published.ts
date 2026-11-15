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
