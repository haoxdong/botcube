"use client";

import { cloneElement, isValidElement, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { CopilotChatView } from "@copilotkit/react-core/v2";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ui/conversation";
import { useScrollUpClosesKeyboard } from "./phone-keyboard-dismiss";
import { useViewport } from "@/design-system/viewport";

const ROTATION_HOLD_MS = 400;
// A reader's scroll starts with one of these; a flick's momentum runs on for a couple of seconds after its touch.
const READER_INPUTS = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"] as const;
const READER_INPUT_MS = 3000;

const boxOf = (contentRef: StickToBottomContext["contentRef"]) => {
  const box = contentRef.current?.parentElement;
  if (box == null) throw new Error("The thread needs Conversation's content box");
  return box;
};

const pageScroller = (box: HTMLElement) => getComputedStyle(box).overflowY === "visible" ? document.documentElement : box;

function PageScroll({ stick }: { stick: StickToBottomContext }) {
  const { scrollRef, contentRef } = stick;
  // Phone CSS switches between the page and the box before React hears the resize.
  useLayoutEffect(() => {
    const box = boxOf(contentRef);
    const root = document.documentElement;
    const swap = () => {
      const scroller = pageScroller(box);
      if (scrollRef.current !== scroller) scrollRef(scroller);
    };
    swap();
    window.addEventListener("resize", swap);
    // Document scroll events target Document, and the library listens on its scroll element.
    const scrolled = (event: Event) => {
      if (event.target === document && scrollRef.current === root) root.dispatchEvent(new Event("scroll"));
    };
    document.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      window.removeEventListener("resize", swap);
      document.removeEventListener("scroll", scrolled);
      scrollRef(box);
    };
  }, [scrollRef, contentRef]);
  return null;
}

function Follow({ stick, page }: { stick: StickToBottomContext; page: boolean }) {
  const { contentRef, scrollRef, state, scrollToBottom, stopScroll } = stick;
  // use-stick-to-bottom follows a resize a frame late, and not its scroll box's own; a ResizeObserver runs before paint.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (content === null) throw new Error("The thread's follow needs Conversation's content box");
    const box = boxOf(contentRef);
    // The composer's room below the rows can shrink, clamping the scroll in a forced layout, in the frame a row grows
    // by as much: the content box ends the frame unchanged and only the rows' box resizes.
    let rows: Element | null = null;
    const roomBelowRows = () => (rows === null ? null : content.getBoundingClientRect().bottom - rows.getBoundingClientRect().bottom);
    let seen: { top: number; written: number; real: number; below: number; rows: Element } | null = null;
    const saw = (top: number, written = top, real = top) => {
      const room = roomBelowRows();
      seen = room === null || rows === null ? null : { top, written, real, below: room, rows };
    };
    let height: number | null = null;
    let pinnedResizeUntil = 0;
    const observer = new ResizeObserver((entries) => {
      // WebKit can lay out the new scroll box before delivering the window resize event.
      const scroller = page ? pageScroller(box) : scrollRef.current;
      const handedOff = scroller !== scrollRef.current;
      if (handedOff) {
        scrollRef(scroller);
        pinnedResizeUntil = state.isAtBottom ? performance.now() + ROTATION_HOLD_MS : 0;
      }
      // The library locks to the end on any shrink that leaves the scroll within 70 px of it, and the write below then
      // jumps a reader who had scrolled up, as a folding Worklog nears its end: one the shrink leaves short of it stays.
      const resized = entries.find(({ target }) => target === content)?.contentRect.height;
      const shrank = resized !== undefined && height !== null && resized < height;
      if (shrank && state.isAtBottom && state.scrollDifference > 1 && performance.now() >= pinnedResizeUntil) stopScroll();
      height = resized ?? height;
      // WebKit can clamp this write to the page's previous height and report it later, as a scroll up from it: the
      // reader is judged from where the scroll was before the write, a clamp from the write.
      const before = state.scrollTop;
      if (state.isAtBottom) state.scrollTop = state.calculatedTargetScrollTop;
      saw(Math.min(before, state.scrollTop), state.scrollTop, seen?.real ?? before);
    });
    observer.observe(content);
    observer.observe(box);
    // The room is padding on a box between the content and the rows, so only that box's border box shows it change.
    let watched: Element[] = [];
    const watchRows = () => {
      const next = content.querySelector("[data-message-id]")?.parentElement ?? null;
      if (next === rows) return;
      for (const box of watched) observer.unobserve(box);
      rows = next;
      watched = [];
      for (let box = rows; box !== null && box !== content; box = box.parentElement) watched.push(box);
      for (const box of watched) observer.observe(box, { box: "border-box" });
    };
    watchRows();
    const joined = new MutationObserver(watchRows);
    joined.observe(content, { childList: true, subtree: true });
    // WebKit reports layout clamps as scroll events before ResizeObserver runs.
    // A reader's scroll leaves the room below the rows intact. Recent input includes flick momentum.
    // When rows are replaced, let the library decide whether to follow.
    let input = Number.NEGATIVE_INFINITY;
    const touched = () => {
      input = performance.now();
    };
    for (const name of READER_INPUTS) window.addEventListener(name, touched, { capture: true, passive: true });
    const scrolled = (event: Event) => {
      const scroller = scrollRef.current;
      if (scroller === null || (event.target === document ? document.documentElement : event.target) !== scroller) return;
      const top = state.scrollTop;
      const room = roomBelowRows();
      const up = seen !== null && seen.top - top > 0.5;
      const drop = seen === null ? 0 : seen.written - top;
      const clamped = drop > 0.5 && seen !== null && room !== null && drop <= seen.below - room + 1;
      const swapped = seen === null || seen.rows !== rows;
      // WebKit can also drop the writes since the last scroll event, the library's included, and report the scroll back where that event left it.
      const reverted = seen !== null && seen.written > seen.real + 0.5 && Math.abs(top - seen.real) <= 0.5;
      const unread = up && performance.now() - input > READER_INPUT_MS;
      if (state.isAtBottom && (state.scrollDifference <= 1 || clamped || reverted || unread)) {
        state.ignoreScrollToTop = top;
        if (unread && !clamped && !reverted && state.scrollDifference > 1) state.scrollTop = state.calculatedTargetScrollTop;
      } else if (state.isAtBottom && up && !swapped && state.animation?.ignoreEscapes !== true) stopScroll();
      saw(top);
    };
    const resized = () => {
      pinnedResizeUntil = state.isAtBottom ? performance.now() + ROTATION_HOLD_MS : 0;
      void scrollToBottom({ animation: "instant", preserveScrollPosition: true, ignoreEscapes: true, duration: ROTATION_HOLD_MS });
    };
    window.addEventListener("resize", resized);
    window.visualViewport?.addEventListener("resize", resized);
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    return () => {
      window.removeEventListener("resize", resized);
      window.visualViewport?.removeEventListener("resize", resized);
      document.removeEventListener("scroll", scrolled, { capture: true });
      for (const name of READER_INPUTS) window.removeEventListener(name, touched, { capture: true });
      joined.disconnect();
      observer.disconnect();
    };
  }, [contentRef, scrollRef, state, stopScroll, scrollToBottom, page]);
  return null;
}

// use-stick-to-bottom 1.1.6 pulls a row past its bottom target (one pixel short of the maximum) back to it, and locks
// to the bottom on a scroll down that ends within 70 px of it unless the write is marked as its own.
function hold(scroller: HTMLElement, to: number, written: RefObject<number | null>, state: StickToBottomContext["state"]) {
  scroller.scrollTop = Math.min(Math.round(to), state.calculatedTargetScrollTop);
  written.current = scroller.scrollTop;
  state.ignoreScrollToTop = scroller.scrollTop;
}

function ReadLine({ stick, opensAt, room, onLanded }: { stick: StickToBottomContext; opensAt: string | null; room: number | undefined; onLanded: () => void }) {
  const { scrollRef, contentRef, state, scrollToBottom } = stick;
  const line = useRef<{ row: Element; top: number } | null>(null);
  const written = useRef<number | null>(null);
  const opening = useRef(opensAt);
  const roomRef = useRef(room);
  roomRef.current = room;
  const landed = useRef(onLanded);
  landed.current = onLanded;
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (content === null) throw new Error("The thread's read line needs Conversation's content box");
    let quietUntil = 0;
    // CopilotChatView pads the rows by the composer's height a render after it measures it, which moves the end. A
    // composer with a height always reports it: CopilotKit observes this same box.
    const composer = content.closest(".copilotKitChat")?.querySelector('[data-testid="copilot-input-overlay"]') ?? null;
    let composerHeight = 0;
    // Runs only from the observer, after a layout, so the opening stays hidden for the frame that lays its rows out
    // and records the sizes they keep once the browser skips them again.
    const land = () => {
      const id = opening.current;
      const scroller = scrollRef.current;
      if (id === null || scroller === null || content.querySelector("[data-message-id]") === null) return;
      if (roomRef.current === 0 && composerHeight > 0) return;
      opening.current = null;
      landed.current();
      const row = content.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
      if (row === null) {
        console.error(`The thread was asked to open at message ${id}, which it does not show, so it opens at its end`);
        hold(scroller, state.calculatedTargetScrollTop, written, state);
        void scrollToBottom("instant");
        return;
      }
      row.scrollIntoView({ block: "start", behavior: "instant" });
      const end = scroller.scrollTop >= state.calculatedTargetScrollTop;
      hold(scroller, scroller.scrollTop, written, state);
      // A row too near the end to reach the top opens the thread at its end, which then follows the composer's room.
      if (end) {
        void scrollToBottom("instant");
        return;
      }
      line.current = { row, top: row.getBoundingClientRect().top };
    };
    const resized = () => {
      quietUntil = performance.now() + ROTATION_HOLD_MS;
    };
    // WebKit fires the hold's own scroll event at the start of the next frame, possibly after more rows joined.
    const scrolled = (event: Event) => {
      const scroller = scrollRef.current;
      if (scroller === null || (event.target === document ? document.documentElement : event.target) !== scroller) return;
      const own = written.current === scroller.scrollTop;
      written.current = null;
      if (own || performance.now() < quietUntil) return;
      if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1) {
        line.current = null;
        return;
      }
      const view = scroller === document.documentElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
      const rows = [...content.querySelectorAll("[data-message-id]")].map((row) => ({ row, box: row.getBoundingClientRect() }));
      // A row cut off above the view can grow below its top as it renders, moving the line read.
      const read = rows.find(({ box }) => box.top >= view.top && box.top < view.bottom) ?? rows.find(({ box }) => box.bottom > view.top);
      line.current = read ? { row: read.row, top: read.box.top } : null;
    };
    // Older transcript joins above the read line. WebKit has no scroll anchoring, and Chromium skips it at scrollTop 0.
    const held = new ResizeObserver((entries) => {
      for (const entry of entries) if (entry.target === composer) composerHeight = entry.contentRect.height;
      land();
      const saved = line.current;
      const scroller = scrollRef.current;
      if (state.isAtBottom || saved === null || !saved.row.isConnected || scroller === null) return;
      const moved = saved.row.getBoundingClientRect().top - saved.top;
      if (Math.abs(moved) >= 0.5) hold(scroller, scroller.scrollTop + moved, written, state);
    });
    held.observe(content);
    if (composer !== null) held.observe(composer);
    window.addEventListener("resize", resized);
    document.addEventListener("scroll", scrolled, { capture: true, passive: true });
    return () => {
      held.disconnect();
      window.removeEventListener("resize", resized);
      document.removeEventListener("scroll", scrolled, { capture: true });
    };
  }, [scrollRef, contentRef, state, scrollToBottom]);
  return null;
}

export function ConversationThread({ children, page, opensAt, room, overlay, className = "chat-scroll-view", contextRef }: {
  children: ReactNode;
  page: boolean;
  opensAt: string | null;
  room?: number;
  overlay?: (stick: StickToBottomContext) => ReactNode;
  className?: string;
  contextRef?: Ref<StickToBottomContext>;
}) {
  const [landed, setLanded] = useState(opensAt === null);
  return (
    <Conversation className={`${className} conversation-thread flex flex-col min-h-0 max-h-full`} initial={opensAt === null ? "instant" : false} resize="instant" data-landing={landed ? undefined : ""} {...(contextRef ? { contextRef } : {})}>
      {(stick: StickToBottomContext) => (
        <>
          <ConversationContent className="block gap-0 p-0">{children}</ConversationContent>
          {page && <PageScroll stick={stick} />}
          <Follow stick={stick} page={page} />
          <ReadLine stick={stick} opensAt={opensAt} room={room} onLanded={() => setLanded(true)} />
          {overlay?.(stick)}
        </>
      )}
    </Conversation>
  );
}

// CopilotChatView pads its scroll content by the composer's rounded offsetHeight, then a frame later by its
// ResizeObserver's fractional height. That sub-pixel shrink can drop scrollHeight a pixel under rows held at the bottom.
function wholePixelEnd(children: ReactNode) {
  const pad = isValidElement<{ style?: CSSProperties }>(children) ? children.props.style?.paddingBottom : undefined;
  if (!isValidElement<{ style?: CSSProperties }>(children) || typeof pad !== "string" || !pad.endsWith("px")) {
    throw new Error("The thread expects CopilotChatView's scroll content padded in px");
  }
  return cloneElement(children, { style: { ...children.props.style, paddingBottom: `${Math.round(Number.parseFloat(pad))}px` } });
}

export function ThreadScrollView({ children, inputContainerHeight = 0, opensAt }: ComponentProps<typeof CopilotChatView.ScrollView> & { opensAt: string | null }) {
  const phone = useViewport() === "phone";
  return (
    <ConversationThread page opensAt={opensAt} room={inputContainerHeight} overlay={(stick) => (
      // Placed above the composer; the library's instant scroll waits for a frame, which WebKit paints first.
      <ConversationScrollButton
        className="chat-scroll-button"
        style={{ bottom: inputContainerHeight + (phone ? 32 : 16) }}
        onClick={() => {
          stick.state.scrollTop = stick.state.calculatedTargetScrollTop;
          void stick.scrollToBottom("instant");
        }}
      />
    )}>
      {phone && <ScrollUpClosesKeyboard />}
      <div className="cpk:overflow-y-auto cpk:overflow-x-hidden" style={{ flex: "1 1 0%", minHeight: 0 }}>
        <div className="cpk:px-4 cpk:@3xl:px-0 cpk:[div[data-sidebar-chat]_&]:px-8 cpk:[div[data-popup-chat]_&]:px-6">{wholePixelEnd(children)}</div>
      </div>
    </ConversationThread>
  );
}

function ScrollUpClosesKeyboard() {
  useScrollUpClosesKeyboard();
  return null;
}
