import type { Published } from "./artifact-published";
import { TYPES } from "./artifact-types";

/** An Artifact's Type icon in its box; on its `tile`, the Type's tint. */
export function ArtifactIcon({ type, tile = false }: { type: Published["type"]; tile?: boolean }) {
  const { Icon, ink, tint } = TYPES[type ?? "page"];
  return <span className={`file-icon ${ink}${tile ? ` rounded-(--radius-md) ${tint}` : ""}`}><Icon aria-hidden /></span>;
}

/** An Artifact's row in the library: its Type's icon on its tile, its title over its Type. */
export function ArtifactFace({ artifact }: { artifact: Published }) {
  return <>
    <ArtifactIcon type={artifact.type} tile />
    <span className="artifact-title">
      <span className="artifact-title-name">{artifact.title}</span>
      <span className="artifact-title-kind">{TYPES[artifact.type ?? "page"].label}</span>
    </span>
  </>;
}
