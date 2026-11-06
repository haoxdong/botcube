/** Marks a reply row that ends at a bubble with words in it: chat.css joins the next reply's bubble to it. */
export const BUBBLE_ENDS = "data-bubble-ends";

const isProse = (element: Element | null | undefined) => element?.classList.contains("cpk:prose") === true;
/** As `:empty`: no element and no text, not even white space, in it. */
const hasContent = (element: Element) => [...element.childNodes].some((node) => node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE);

/** Marq's row ends at a bubble with words in it when only its hidden toolbar, no tool row, follows the bubble. */
function endsAtBubble(row: Element) {
  if (!row.classList.contains("copilotKitAssistantMessage")) return false;
  const words = [...row.children].some((child) => isProse(child) && [...child.children].some((markdown) => markdown.classList.contains("chat-markdown") && hasContent(markdown)));
  const last = row.lastElementChild;
  return words && (isProse(last) || (last?.classList.contains("cpk:bg-transparent") === true && isProse(last.previousElementSibling)));
}

/**
 * Keeps BUBBLE_ENDS on each row of `list` that ends at its bubble, read once per row that changed. As a stylesheet
 * rule, a `:has()` on the row before a `+` had the browser restyle the list on every streamed word and every send.
 */
export function markBubbleEnds(list: HTMLElement | null): (() => void) | undefined {
  if (list === null) return undefined;
  const mark = (row: Element) => row.toggleAttribute(BUBBLE_ENDS, endsAtBubble(row));
  const changed = new MutationObserver((records) => {
    const rows = new Set<Element>();
    for (const { target, addedNodes } of records) {
      if (target === list) addedNodes.forEach((node) => { if (node instanceof Element) rows.add(node); });
      else {
        let row: Node | null = target;
        while (row !== null && row.parentNode !== list) row = row.parentNode;
        if (row instanceof Element) rows.add(row);
      }
    }
    rows.forEach(mark);
  });
  changed.observe(list, { childList: true, subtree: true, characterData: true });
  for (const row of list.children) mark(row);
  return () => changed.disconnect();
}
