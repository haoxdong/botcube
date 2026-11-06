// The DCV Web Client UI that bedrock-agentcore's live view renders ships no types; its one export as the live view passes it.
declare module 'dcv-ui' {
  import type { FC } from 'react';

  export const DCVViewer: FC<{ dcv: Record<string, unknown>; uiConfig?: { toolbar?: Record<string, boolean> } }>;
}
