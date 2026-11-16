import type { Published } from "./artifact-published";
import { TYPES } from "./artifact-types";

export function ArtifactFace({ artifact, tile = false }: { artifact: Published; tile?: boolean }) {
  const { Icon, label, ink, tint } = TYPES[artifact.type ?? "page"];
  return <>
    <span className={`file-icon ${ink}${tile ? ` rounded-(--radius-md) ${tint}` : ""}`}><Icon aria-hidden /></span>
    <span className="sent-file-text">
      <span className="sent-file-name">{artifact.title}</span>
      <span className="sent-file-kind">{label}</span>
    </span>
  </>;
}
