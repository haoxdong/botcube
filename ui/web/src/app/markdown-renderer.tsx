import "katex/dist/katex.min.css";
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

/** A reply's words, through the one reply part: AI Elements' MessageResponse. */
export default function MarkdownRenderer({ content }: { content: string }) {
  const running = useContext(ReplyTurnRunning);
  const props = {
    ...MARKDOWN_RENDERER,
    className: "chat-markdown",
    remarkPlugins: [...MARKDOWN_RENDERER.remarkPlugins, [remarkRepairedBracketMath, content]] as typeof MARKDOWN_RENDERER.remarkPlugins,
    rehypePlugins: REPLY_REHYPE_PLUGINS,
    ...(running ? { remend: STREAMING_REPAIRS } : {}),
  };
  return <OpenFence.Provider value={running ? openFence(content) : null}><MessageResponse {...props}>{content}</MessageResponse></OpenFence.Provider>;
}
