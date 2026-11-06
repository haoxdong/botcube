/** How long a chat that has laid out waits to open at its latest message before it opens anyway. */
export const OPENING_MS = 1000;
/** As OPENING_MS, for a chat whose replies are still rendering. */
const RENDERING_OPENING_MS = 3000;

/** CopilotKit also styles its full-height content wrapper to scroll; skip it when it has no overflow. */
export function scrollParent(element: Element): Element | null {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) return parent;
  }
  const page = document.scrollingElement;
  return page !== null && page.scrollHeight > page.clientHeight ? page : null;
}

export function messagesScroller(wrapper: Element | null): Element | null {
  const list = wrapper?.querySelector('[data-testid="copilot-message-list"]');
  return list ? scrollParent(list) : null;
}

/**
 * Whether the chat in `wrapper` has padded its content by its composer's height. CopilotKit measures the composer some
 * commits after it mounts and pads by only 32px until then, so a chat at its end before that moves once the padding
 * arrives. A chat without both parts has no composer to make room for.
 */
function hasComposerRoom(wrapper: Element | null): boolean {
  const content = wrapper?.querySelector<HTMLElement>('[data-testid="copilot-scroll-content"]');
  const composer = wrapper?.querySelector<HTMLElement>('[data-testid="copilot-input-overlay"]');
  return !content || !composer || parseFloat(content.style.paddingBottom) >= composer.offsetHeight;
}

/**
 * Streamdown mounts a diagram at zero height before its pan/zoom viewport lays it out, and a reply's file link reads
 * "(loading)" on one line until its file resolves to a link or a longer alert. A reply image fades in only once
 * it has loaded or failed.
 */
function hasRenderedReplies(wrapper: Element | null): boolean {
  if (wrapper?.querySelector('.copilotKitAssistantMessage :is([class~="animate-spin"], [class~="cpk:animate-spin"], [data-reply-file-loading])')) return false;
  if ([...(wrapper?.querySelectorAll<HTMLImageElement>('.reply-image > img:not([data-loaded])') ?? [])].some((image) => !image.complete)) return false;
  return [...(wrapper?.querySelectorAll('[data-streamdown="mermaid-block"]') ?? [])].every((block) =>
    (block.querySelector('[data-streamdown="mermaid"]')?.getBoundingClientRect().height ?? 0) > 0);
}

/** The bottom of the latest message in `wrapper`, on screen. */
const latestBottom = (wrapper: Element | null) => [...(wrapper?.querySelectorAll(".copilotKitMessage") ?? [])].at(-1)?.getBoundingClientRect().bottom;

/**
 * Calls `onOpened` on the first frame the chat in `wrapper` shows at its latest message, with room made for its
 * composer and its replies rendered: CopilotKit's scroll view reaches the latest message some frames after it mounts,
 * and keeps to it a frame after a reply grows, so the chat opens only once that message held still since the
 * frame before, and its wait for that counts from when its replies rendered. Mermaid initialization can outlast
 * scroll settling, but a stalled renderer must not hide the chat indefinitely. The messages it held as it opened are
 * marked `data-opened`: history, which shows without the entrance fade. Returns what stops watching.
 */
export function watchOpening(wrapper: () => Element | null, onOpened: () => void): () => void {
  const started = performance.now();
  let held: number | undefined;
  let rendered: number | undefined;
  let checked = false;
  let frame = requestAnimationFrame(function checkOpened(now) {
    const shown = wrapper();
    const scroller = messagesScroller(shown);
    const atEnd = scroller === null || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
    const loadingEarlier = scroller === null && !!shown?.querySelector("[data-chat-earlier]");
    const repliesReady = hasRenderedReplies(shown);
    if (repliesReady) rendered ??= checked ? now : started;
    const bottom = latestBottom(shown);
    const still = bottom === held;
    held = bottom;
    checked = true;
    const late = rendered === undefined ? now - started >= RENDERING_OPENING_MS : now - rendered >= OPENING_MS;
    if ((atEnd && still && !loadingEarlier && repliesReady && hasComposerRoom(shown)) || late) {
      shown?.querySelectorAll(".copilotKitMessage").forEach((message) => message.setAttribute("data-opened", ""));
      onOpened();
    }
    else frame = requestAnimationFrame(checkOpened);
  });
  return () => cancelAnimationFrame(frame);
}
