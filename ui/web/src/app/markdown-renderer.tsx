import { CopilotChatAssistantMessage } from "@copilotkit/react-core/v2";
import { webUiPlugin } from "@cartridge-ui";

import { MARKDOWN_RENDERER } from "./markdown";
import { ReplyImage } from "./reply-image";
import { ReplyFileLink } from "./reply-file-link";
import { rehypeReplyFiles } from "./reply-file-path";

const COMPONENTS = { img: ReplyImage, a: ReplyFileLink };
const REPLY_REHYPE_PLUGINS = [rehypeReplyFiles, ...MARKDOWN_RENDERER.rehypePlugins];

export default function MarkdownRenderer({ content }: { content: string }) {
  return (
    <CopilotChatAssistantMessage.MarkdownRenderer
      {...MARKDOWN_RENDERER}
      rehypePlugins={webUiPlugin.fileUrl ? REPLY_REHYPE_PLUGINS : MARKDOWN_RENDERER.rehypePlugins}
      components={COMPONENTS}
      content={content}
    />
  );
}
