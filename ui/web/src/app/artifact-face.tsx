import type { Published } from "./artifact-published";
import { TYPES } from "./artifact-types";

export function ArtifactFace({ artifact }: { artifact: Published }) {
  const { Icon, label, ink } = TYPES[artifact.type ?? "page"];
  return <>
    <span className={`file-icon ${ink}`}><Icon aria-hidden /></span>
    <span className="sent-file-text">
      <span className="sent-file-name">{artifact.title}</span>
      <span className="sent-file-kind">{label}</span>
    </span>
  </>;
}
