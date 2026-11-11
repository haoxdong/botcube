/**
 * The Artifacts flag, a build-time flag, off by default: the reply shows the `Artifact` tool's pages as
 * cards that open beside the chat. The harness's BOTCUBE_ARTIFACTS gives the agent the tool.
 */
export const artifactsEnabled = () => process.env.NEXT_PUBLIC_ARTIFACTS === '1';
