import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { useStickToBottom } from "use-stick-to-bottom";

import { zoomOf } from "@/lib/utils";
import { messagesScroller } from "./chat-opening";
import { PHONE_QUERY } from "./phone-query";

export const AT_BOTTOM_PX = 70;

type Position = { phone: boolean } & ({ kind: "latest" } | { kind: "reading"; row: Element; top: number });

export function useRotationReading(phone: boolean, initial: boolean) {
  const options = phone ? { initial: false, resize: false } as const : { initial: initial ? "instant" : false, resize: "instant" } as const;
  const desktop = useStickToBottom({ initial: !phone && initial ? "instant" : false, resize: "instant" });
  const content = useRef<HTMLDivElement>(null);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => { content.current = node; setElement(node); }, []);
  const opened = useRef(false);
  useLayoutEffect(() => { if (!phone) opened.current = true; }, [phone]);
  const position = useRef<Position | null>(null);
  useLayoutEffect(() => {
    if (!element) return;
    let width = innerWidth;
    const previous = position.current;
    let owner = messagesScroller(element);
    let height = owner?.scrollHeight;
    const restore = (saved = previous) => {
      if (!saved) return;
      const scroller = messagesScroller(element);
      if (!scroller) return;
      if (saved.kind === "latest") scroller.scrollTop = scroller.scrollHeight;
      else if (saved.row.isConnected) scroller.scrollTop += (saved.row.getBoundingClientRect().top - saved.top) / zoomOf(scroller);
    };
    const remember = () => {
      if (innerWidth !== width || matchMedia(PHONE_QUERY).matches !== phone) return;
      const scroller = messagesScroller(element);
      if (!scroller) return;
      if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= AT_BOTTOM_PX) {
        position.current = { phone, kind: "latest" };
        return;
      }
      const saved = position.current;
      if (saved?.kind === "reading" && saved.row.isConnected && Math.abs(saved.row.getBoundingClientRect().top - saved.top) <= 1) {
        position.current = { ...saved, phone };
        return;
      }
      const list = element.querySelector('[data-testid="copilot-message-list"]');
      const row = [...list?.children ?? []].find(child => child.getBoundingClientRect().bottom > 1 && child.getBoundingClientRect().height > 0);
      if (row) position.current = { phone, kind: "reading", row, top: row.getBoundingClientRect().top };
    };
    if (previous?.phone !== phone) restore();
    const frame = requestAnimationFrame(() => { if (previous?.phone !== phone) restore(); remember(); });
    const resized = () => {
      restore(position.current);
      if (matchMedia(PHONE_QUERY).matches === phone) { width = innerWidth; remember(); }
    };
    const scrolled = () => {
      const scroller = messagesScroller(element);
      if (scroller === owner && scroller?.scrollHeight === height) remember();
    };
    window.addEventListener("resize", resized);
    document.addEventListener("scroll", scrolled, true);
    const padded = element.querySelector('[data-testid="copilot-scroll-content"]');
    const dimensions = () => [owner?.clientWidth, owner?.clientHeight, padded ? getComputedStyle(padded).padding : null].join();
    let viewport: string | undefined;
    const measure = () => {
      owner = messagesScroller(element);
      const next = dimensions();
      if (viewport === undefined ? previous?.phone !== phone : viewport !== next) restore(position.current);
      viewport = next;
      height = owner?.scrollHeight;
      remember();
    };
    const observer = new ResizeObserver(measure);
    const padding = new MutationObserver(() => { if (previous?.phone === !phone && position.current?.kind === "latest") measure(); });
    if (padded) padding.observe(padded, { attributes: true, attributeFilter: ["style"] });
    const list = element.querySelector('[data-testid="copilot-message-list"]');
    if (list) observer.observe(list);
    if (padded) observer.observe(padded, { box: "border-box" });
    if (owner) observer.observe(owner, { box: "border-box" });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      padding.disconnect();
      window.removeEventListener("resize", resized);
      document.removeEventListener("scroll", scrolled, true);
    };
  }, [element, phone]);
  const follow = useCallback(() => { position.current = { phone, kind: "latest" }; }, [phone]);
  const followsLatest = useCallback(() => position.current?.kind === "latest", []);
  const { scrollToBottom } = desktop;
  useLayoutEffect(() => {
    if (!phone && followsLatest()) void scrollToBottom({ animation: "instant" });
  }, [phone, followsLatest, scrollToBottom]);
  return { attach, content, opened, followsLatest, follow, instance: desktop, options };
}

export function useInitialStick(opened: RefObject<boolean>, followsLatest: () => boolean) {
  const [initial] = useState(() => !opened.current || followsLatest());
  useLayoutEffect(() => { opened.current = true; }, [opened]);
  return initial;
}
