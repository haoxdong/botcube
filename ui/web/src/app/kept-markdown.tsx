import { defaultRehypePlugins, defaultRemarkPlugins, Streamdown } from "streamdown";
import { remarkRepairedBracketMath } from "./remark-bracket-math";
import { rehypeReplyFiles } from "./reply-file-path";
import { REPLY_MARKDOWN } from "./reply-markdown";

const KEPT_REHYPE_PLUGINS = Object.values(defaultRehypePlugins).toSpliced(-1, 0, rehypeReplyFiles);

export default function KeptMarkdown({ text }: { text: string }) {
  return <Streamdown {...REPLY_MARKDOWN} rehypePlugins={KEPT_REHYPE_PLUGINS} remarkPlugins={[...Object.values(defaultRemarkPlugins), [remarkRepairedBracketMath, text]]}>{text}</Streamdown>;
}
