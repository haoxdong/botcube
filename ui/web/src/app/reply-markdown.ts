import { ReplyFileLink } from "./reply-file-link";
import { ReplyImage } from "./reply-image";

/**
 * How a reply shows its links and images: a link opens, with no safety prompt; a file the agent wrote downloads; a
 * citation is a pill. The chat surface and the kept chat shown while it loads both use it, so a reopened chat looks
 * the same from its first frame; it leaves out the chat surface's heavier plugins, which load with it.
 */
export const REPLY_MARKDOWN = {
  linkSafety: { enabled: false },
  components: { img: ReplyImage, a: ReplyFileLink },
};
