import { m as motionElement } from "framer-motion";
import { Presence, presenceMotion } from "../app/collapse";
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileTypeIcon } from '../components/file-type-icon';

/**
 * An image's own picture, from the short-lived URL `thumbnailUrl` gives for its path; its type icon until the picture
 * has loaded.
 * One whose URL fails, or that the browser won't show, keeps its type icon and tells `onFailure` why.
 */
export function Thumbnail({ path, name, thumbnailUrl, onFailure }: {
  path: string;
  name: string;
  thumbnailUrl: (path: string) => Promise<string>;
  onFailure: (message: string) => void;
}) {
  const [shown, setShown] = useState<{ path: string; url: string | null } | null>(null);
  const failing = useRef(onFailure);
  failing.current = onFailure;
  const fail = useCallback((why: string) => {
    setShown({ path, url: null });
    failing.current(`${name} could not load: ${why}`);
  }, [path, name]);
  useEffect(() => {
    let current = true;
    thumbnailUrl(path).then(
      (url) => current && setShown({ path, url }),
      (error: unknown) => current && fail(error instanceof Error ? error.message : String(error)),
    );
    return () => {
      current = false;
    };
  }, [path, thumbnailUrl, fail]);
  // The URL whose picture has loaded: until it has, the cell keeps its type icon and the picture loads unseen beside it,
  // so the cell never shows an empty box between the two.
  const [loaded, setLoaded] = useState<string | null>(null);
  const url = shown?.path === path ? shown.url : null;
  const ready = url !== null && loaded === url;
  return (
    <span className="file-thumbnail" aria-hidden="true">
      <Presence>{!ready && <motionElement.span {...presenceMotion} key="icon"><FileTypeIcon name={name} /></motionElement.span>}</Presence>
      <Presence>{url !== null && (
      <motionElement.img {...presenceMotion} key={url} animate={{ opacity: ready ? 1 : 0 }}
        src={url}
        alt=""
        loading="lazy"
        draggable={false}
        data-loading={ready ? undefined : true}
        onLoad={() => setLoaded(url)}
        onError={() => fail('the browser could not show it')}
      />
      )}</Presence>
    </span>
  );
}
