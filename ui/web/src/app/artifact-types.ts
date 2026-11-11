import { DOC_EXPORTS, DOC_WRITES, EditableDoc } from "./artifact-doc";
import { EditableDeck } from "./artifact-edit";
import { EditableEmail, EML } from "./artifact-email";
import { PAGE_WRITES, VersionFrame } from "./artifact-page";
import { EXCEL, SheetVersion } from "./artifact-sheet";
import { PDF, type ArtifactType } from "./artifact-viewer";
import { POWERPOINT } from "./slides-download";

/** Each Artifact Type in the panel, with its Exports from ADR 0087's table. */
export const TYPES = {
  page: { label: "Page", Viewer: VersionFrame, exports: [PDF], stored: "", writes: PAGE_WRITES },
  slides: { label: "Slides", Viewer: EditableDeck, exports: [POWERPOINT, PDF], stored: "/project/deck.json", writes: null },
  doc: { label: "Doc", Viewer: EditableDoc, exports: DOC_EXPORTS, stored: "", writes: DOC_WRITES },
  sheet: { label: "Sheet", Viewer: SheetVersion, exports: [EXCEL], stored: "", writes: null },
  email: { label: "Email", Viewer: EditableEmail, exports: [EML], stored: "", writes: null },
} satisfies Record<string, ArtifactType>;

/** The type of a one-file Source the agent writes, if the panel previews it. */
export const writtenType = (path: string): ArtifactType | undefined =>
  Object.values<ArtifactType>(TYPES).find(({ writes }) => writes?.matches(path) ?? false);
