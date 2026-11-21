import "katex/dist/katex.min.css";
import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";
import { MessageResponse } from "@/components/ui/message";
import { useContext } from "react";

import { MARKDOWN_RENDERER, tableInProgress } from "./markdown";
import { remarkRepairedBracketMath } from "./remark-bracket-math";
import { rehypeReplyFiles } from "./reply-file-path";
import { OpenFence, openFence, ReplyTurnRunning } from "./reply-turn";

// Between sanitize, which would drop the mark rehypeReplyFiles gives a file card, and harden, the last, which would block
// the bare paths it resolves.
const REPLY_REHYPE_PLUGINS = MARKDOWN_RENDERER.rehypePlugins.toSpliced(-1, 0, rehypeReplyFiles);
/** While a Turn runs, a table arriving holds back until its delimiter row completes it. */
const STREAMING_REPAIRS = { handlers: [tableInProgress] };

function useReplyMarkdown(content: string) {
  const running = useContext(ReplyTurnRunning);
  return {
    fence: running ? openFence(content) : null,
    props: {
      ...MARKDOWN_RENDERER,
      className: "chat-markdown",
      remarkPlugins: [...MARKDOWN_RENDERER.remarkPlugins, [remarkRepairedBracketMath, content]] as typeof MARKDOWN_RENDERER.remarkPlugins,
      rehypePlugins: REPLY_REHYPE_PLUGINS,
      ...(running ? { remend: STREAMING_REPAIRS } : {}),
    },
  };
}

/** A reply CopilotKit still renders (one that calls tools or publishes Artifacts): its renderer, whose prose classes its styles read. */
export default function MarkdownRenderer({ content }: { content: string }) {
  const { fence, props } = useReplyMarkdown(content);
  return <OpenFence.Provider value={fence}><CopilotChatAssistantMessage.MarkdownRenderer {...props} content={content} /></OpenFence.Provider>;
}

/** A reply in the stock bubble: AI Elements' MessageResponse. */
export function StockMarkdownRenderer({ content }: { content: string }) {
  const { fence, props } = useReplyMarkdown(content);
  return <OpenFence.Provider value={fence}><MessageResponse {...props}>{content}</MessageResponse></OpenFence.Provider>;
}
