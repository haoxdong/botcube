import { defaultRemarkPlugins, Streamdown } from "streamdown";
import { remarkRepairedBracketMath } from "./remark-bracket-math";
import { rehypeReplyFiles } from "./reply-file-path";
import { REPLY_MARKDOWN, replyRehypePlugins } from "./reply-markdown";

const KEPT_REHYPE_PLUGINS = replyRehypePlugins().toSpliced(-1, 0, rehypeReplyFiles);

export default function KeptMarkdown({ text }: { text: string }) {
  return <Streamdown {...REPLY_MARKDOWN} rehypePlugins={KEPT_REHYPE_PLUGINS} remarkPlugins={[...Object.values(defaultRemarkPlugins), [remarkRepairedBracketMath, text]]}>{text}</Streamdown>;
}
