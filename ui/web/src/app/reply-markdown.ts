import { defaultRehypePlugins } from "streamdown";
import { InlineCode } from "./code-words";
import { ReplyFileLink } from "./reply-file-link";
import { ReplyVisual } from "./reply-chart";

/**
 * How a reply shows its links, images and code: a link opens, with no safety prompt; a file the agent wrote downloads; a Plotly figure draws as a live chart;
 * a citation is a pill; inline code wraps only between its words. The chat surface and the kept chat shown while it
 * loads both use it, so a reopened chat looks the same from its first frame; it leaves out the chat surface's heavier
 * plugins, which load with it.
 */
export const REPLY_MARKDOWN = {
  linkSafety: { enabled: false },
  components: { img: ReplyVisual, a: ReplyFileLink, inlineCode: InlineCode },
};

type Pluggable = (typeof defaultRehypePlugins)[string];
const [harden, hardenOptions] = defaultRehypePlugins.harden as [unknown, object];

/**
 * Harden passes an image only at a path, as the agent embeds its files; ReplyImage loads it from Files. It needs an
 * origin to resolve a path against: a reserved one no address can match.
 */
export function replyRehypePlugins(links: { linkBlockPolicy?: "text-only" } = {}): Pluggable[] {
  const images = { defaultOrigin: "https://reply.invalid", allowedImagePrefixes: ["/"], allowDataImages: false };
  return Object.values({ ...defaultRehypePlugins, harden: [harden, { ...hardenOptions, ...images, ...links }] as Pluggable });
}
