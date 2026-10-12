import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";
import { webUiPlugin } from "@cartridge-ui";

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
      rehypePlugins={webUiPlugin.fileUrl ? REPLY_REHYPE_PLUGINS : MARKDOWN_RENDERER.rehypePlugins}
      components={REPLY_MARKDOWN.components}
      content={content}
    />
  );
}
