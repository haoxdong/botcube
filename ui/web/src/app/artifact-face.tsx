import type { Published } from "./artifact-published";
import { TYPES } from "./artifact-types";

export function ArtifactFace({ artifact }: { artifact: Published }) {
  const { Icon, label } = TYPES[artifact.type ?? "page"];
  return <>
    <span className="file-icon"><Icon aria-hidden /></span>
    <span className="sent-file-text">
      <span className="sent-file-name">{artifact.title}</span>
      <span className="sent-file-kind">{label} Artifact · version {artifact.version}{artifact.author === "user" ? " · saved by you" : ""}</span>
      <span className="artifact-card-description" hidden={!artifact.description}>{artifact.description}</span>
    </span>
  </>;
}
