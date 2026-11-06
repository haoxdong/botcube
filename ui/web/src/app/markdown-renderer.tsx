import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";
import { useContext } from "react";

import { MARKDOWN_RENDERER, tableInProgress } from "./markdown";
import { remarkRepairedBracketMath } from "./remark-bracket-math";
import { rehypeReplyFiles } from "./reply-file-path";
import { REPLY_MARKDOWN } from "./reply-markdown";
import { ReplyTurnRunning } from "./reply-turn";

// Between sanitize, which would drop the mark rehypeReplyFiles gives a file card, and harden, the last, which would block
// the bare paths it resolves.
const REPLY_REHYPE_PLUGINS = MARKDOWN_RENDERER.rehypePlugins.toSpliced(-1, 0, rehypeReplyFiles);
/** While a Turn runs, a table arriving holds back until its delimiter row completes it. */
const STREAMING_REPAIRS = { handlers: [tableInProgress] };

export default function MarkdownRenderer({ content }: { content: string }) {
  const running = useContext(ReplyTurnRunning);
  return (
    <CopilotChatAssistantMessage.MarkdownRenderer
      {...MARKDOWN_RENDERER}
      className="chat-markdown"
      remarkPlugins={[...MARKDOWN_RENDERER.remarkPlugins, [remarkRepairedBracketMath, content]]}
      rehypePlugins={REPLY_REHYPE_PLUGINS}
      {...(running ? { remend: STREAMING_REPAIRS } : {})}
      components={REPLY_MARKDOWN.components}
      content={content}
    />
  );
}
