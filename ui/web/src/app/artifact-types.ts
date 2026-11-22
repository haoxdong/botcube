import { FileTextIcon, GlobeIcon, MailIcon, MonitorIcon, Table2Icon } from "lucide-react";

import { DOC_EXPORTS, EditableDoc } from "./artifact-doc";
import { EditableDeck } from "./artifact-edit";
import { EditableEmail, EML } from "./artifact-email";
import { HTML, VersionFrame } from "./artifact-page";
import { EXCEL, SheetVersion } from "./artifact-sheet";
import { PDF, type ArtifactType } from "./artifact-viewer";
import { POWERPOINT } from "./slides-download";

/** Each Artifact Type in the panel, with its Exports from ADR 0087's table. */
export const TYPES = {
  page: { tint: "bg-(--violet-3)!", ink: "text-(--violet-11)!", Icon: GlobeIcon, label: "Page", Viewer: VersionFrame, exports: [HTML, PDF], stored: "" },
  slides: { tint: "bg-(--red-3)!", ink: "text-(--red-11)!", Icon: MonitorIcon, label: "Slides", Viewer: EditableDeck, exports: [POWERPOINT, PDF], stored: "/project/deck.json" },
  doc: { tint: "bg-(--blue-3)!", ink: "text-(--blue-11)!", Icon: FileTextIcon, label: "Doc", Viewer: EditableDoc, exports: DOC_EXPORTS, stored: "" },
  sheet: { tint: "bg-(--green-3)!", ink: "text-(--green-11)!", Icon: Table2Icon, label: "Sheet", Viewer: SheetVersion, exports: [EXCEL], stored: "" },
  email: { tint: "bg-(--amber-3)!", ink: "text-(--amber-11)!", Icon: MailIcon, label: "Email", Viewer: EditableEmail, exports: [EML], stored: "" },
} satisfies Record<string, ArtifactType>;
