import { useCallback, useLayoutEffect, useRef, type UIEvent } from "react";

export function useArtifactScroll() {
  const element = useRef<HTMLElement | null>(null);
  const position = useRef({ left: 0, top: 0 });
  const ref = useCallback((next: HTMLElement | null) => { element.current = next; }, []);
  const onScroll = useCallback(({ currentTarget }: UIEvent<HTMLElement>) => {
    position.current = { left: currentTarget.scrollLeft, top: currentTarget.scrollTop };
  }, []);
  useLayoutEffect(() => {
    if (element.current === null) return;
    element.current.scrollLeft = position.current.left;
    element.current.scrollTop = position.current.top;
  });
  return { ref, onScroll };
}
