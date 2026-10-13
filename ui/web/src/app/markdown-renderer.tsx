import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";

import { MARKDOWN_RENDERER } from "./markdown";
import { remarkRepairedBracketMath } from "./remark-bracket-math";
import { rehypeReplyFiles } from "./reply-file-path";
import { REPLY_MARKDOWN } from "./reply-markdown";

const REPLY_REHYPE_PLUGINS = [rehypeReplyFiles, ...MARKDOWN_RENDERER.rehypePlugins];

export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <CopilotChatAssistantMessage.MarkdownRenderer
      {...MARKDOWN_RENDERER}
      remarkPlugins={[...MARKDOWN_RENDERER.remarkPlugins, [remarkRepairedBracketMath, content]]}
      rehypePlugins={REPLY_REHYPE_PLUGINS}
      components={REPLY_MARKDOWN.components}
      content={content}
    />
  );
}
