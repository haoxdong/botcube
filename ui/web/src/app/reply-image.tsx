"use client";

import { m as motionElement } from "motion/react";
import { Presence, presenceMotion } from "./collapse";
import { useState, type ComponentProps, type SyntheticEvent } from 'react';
import { DownloadIcon } from 'lucide-react';
import { agentFiles } from './agent-files';
import { reason } from './composer-files';

import { keepSize, sizeOf, type Size } from './late-boxes';
import { linkedPath } from './files-path';
import { useReplyFile } from './use-reply-file';
import { Button } from "@/components/ui/button";

/** An image's box before its size is known: the bubble's width at 16:9, a chart's usual shape. */
const UNSIZED: Size = { width: 1600, height: 900 };

async function saveImage(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download =
    new URL(url, window.location.origin).pathname.split('/').pop() || 'image';
  link.click();
  URL.revokeObjectURL(link.href);
}

/**
 * An image an assistant reply embeds, in place of streamdown's own and with its look and Download button. An image
 * the reply names by a path is one of the agent's files: it shows from a short-lived URL to it in Files, and downloads
 * from a fresh one; one that fails to show is named in its place.
 *
 * Its box is there from the reply's first frame, at the size the image last loaded at or 16:9 until it has,
 * and the picture fades into it. In a row that joined the history above the reader the box keeps that size, so
 * nothing above the row read moves; elsewhere it takes the image's own size as it loads.
 */
export function ReplyImage({ src, alt, title }: ComponentProps<'img'>) {
  const path = typeof src === 'string' ? linkedPath(src) : null;
  const { file, imageFailed } = useReplyFile(path);
  const shown = path
    ? file
    : { status: 'ready' as const, url: typeof src === 'string' ? src : '' };
  const key = `image:${path ?? (typeof src === 'string' ? src : '')}`;
  const [size, setSize] = useState(() => sizeOf(key));
  const [loaded, setLoaded] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (shown?.status === 'ready' && !shown.url) return null;
  const download = () => {
    if (shown?.status !== 'ready') return;
    setDownloadError(null);
    void (
      path
        ? agentFiles.url(path).then((url) => window.location.assign(url))
        : saveImage(shown.url)
    ).catch((error: unknown) => setDownloadError(reason(error)));
  };
  const box = size ?? UNSIZED;
  return (
    <>
      <div
        className="reply-image group relative my-4 inline-block"
        data-streamdown="image-wrapper"
        style={{ width: `${box.width}px`, aspectRatio: `${box.width} / ${box.height}` }}
      >
        <Presence>{shown?.status === 'ready' && (
          <>
            <motionElement.img {...presenceMotion} key="0"
              alt={alt}
              data-loaded={loaded ? '' : undefined}
              data-streamdown="image"
              onError={path ? imageFailed : undefined}
              onLoad={({ currentTarget: image }: SyntheticEvent<HTMLImageElement>) => {
                const natural = { width: image.naturalWidth, height: image.naturalHeight };
                keepSize(key, natural);
                setSize(natural);
                setLoaded(true);
              }}
              src={shown.url}
              title={title}
            />
            <motionElement.div {...presenceMotion} key="1" className="pointer-events-none absolute inset-0 hidden group-hover:block">
              <div data-testid="reply-image-scrim" className="h-full rounded-lg bg-(--scrim) opacity-30" />
            </motionElement.div>
            <motionElement.div {...presenceMotion} key="2" className="absolute right-2 bottom-2">
              <Button
                variant="outline"
                size="icon"
                onClick={download}
                title="Download image"
                type="button"
              >
                <DownloadIcon size={14} />
              </Button>
            </motionElement.div>
          </>
        )}</Presence>
        <Presence>{shown !== null && shown.status !== 'ready' && (
          <motionElement.span {...presenceMotion} className="reply-image-error" role="alert">{`${alt || path} could not load: ${shown.reason}`}</motionElement.span>
        )}</Presence>
      </div>
      <Presence>{downloadError && (
        <motionElement.span {...presenceMotion} role="alert">{`${alt || 'The image'} could not download: ${downloadError}`}</motionElement.span>
      )}</Presence>
    </>
  );
}
