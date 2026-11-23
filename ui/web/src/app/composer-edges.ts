// Stock menu and popover content places itself against its trigger. A composer control's menu or card opens over the
// composer instead: these are the trigger's distances in from the composer's top, left and right edges, for its
// sideOffset and alignOffset.
export function composerEdges(trigger: HTMLElement | null) {
  const composer = trigger?.closest(".chat-composer");
  if (!trigger || !composer) return { above: 0, left: 0, right: 0 };
  const t = trigger.getBoundingClientRect();
  const c = composer.getBoundingClientRect();
  return { above: t.top - c.top, left: t.left - c.left, right: c.right - t.right };
}
