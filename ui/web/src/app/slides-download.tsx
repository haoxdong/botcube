"use client";

import { PresentationIcon } from "lucide-react";

import { readDeck } from "./artifact-slides";
import { PDF, saveFile, storedVersion, type Export } from "./artifact-viewer";

/**
 * Download as PowerPoint, the Slides type's Export: the stored version on screen, read from Files and written by
 * PptxGenJS, which loads only once the User downloads. A deck the agent is still writing is refused.
 */
export const POWERPOINT: Export = {
  label: "Download as PowerPoint",
  Icon: PresentationIcon,
  failed: "the PowerPoint",
  stored: true,
  instead: PDF,
  run: async (target) => {
    const { title, read } = target;
    const { path } = storedVersion(target, "the deck");
    const files = await readDeck(path, read);
    const { deckPptx } = await import("./slides-pptx");
    saveFile(await deckPptx(title, path, files), `${title}.pptx`);
  },
};
