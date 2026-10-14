'use client';

import { useState, type ComponentProps } from 'react';
import { DownloadIcon } from 'lucide-react';
import { agentFiles } from './agent-files';

import { replyFilePath } from './reply-file-path';
import { useReplyFile } from './use-reply-file';

async function saveImage(url: string) {
  const blob = await (await fetch(url)).blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download =
    new URL(url, window.location.origin).pathname.split('/').pop() || 'image';
  link.click();
  URL.revokeObjectURL(link.href);
}

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * An image an assistant reply embeds, in place of streamdown's own and with its look and Download button. An image
 * the reply names by a path is one of the agent's files: it shows from a short-lived URL to it in Files, and downloads
 * from a fresh one; one that fails to show is named in its place.
 */
export function ReplyImage({ src, alt, title }: ComponentProps<'img'>) {
  const path = typeof src === 'string' ? replyFilePath(src) : null;
  const { file, imageFailed } = useReplyFile(path);
  const shown = path
    ? file
    : { status: 'ready' as const, url: typeof src === 'string' ? src : '' };
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (shown === null || (shown.status === 'ready' && !shown.url)) return null;
  if (shown.status !== 'ready')
    return (
      <span role="alert">{`${alt || path} could not load: ${shown.reason}`}</span>
    );
  const download = () => {
    setDownloadError(null);
    void (
      path
        ? agentFiles.url(path).then((url) => window.location.assign(url))
        : saveImage(shown.url)
    ).catch((error: unknown) => setDownloadError(reason(error)));
  };
  return (
    <>
      <div
        className="group relative my-4 inline-block"
        data-streamdown="image-wrapper"
      >
        <img
          alt={alt}
          className="max-w-full rounded-lg"
          data-streamdown="image"
          onError={path ? imageFailed : undefined}
          src={shown.url}
          title={title}
        />
        <div className="pointer-events-none absolute inset-0 hidden rounded-lg bg-black/10 group-hover:block" />
        <button
          className="absolute right-2 bottom-2 flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-border bg-background/90 shadow-sm backdrop-blur-sm transition-all duration-200 hover:bg-background opacity-0 group-hover:opacity-100"
          onClick={download}
          title="Download image"
          type="button"
        >
          <DownloadIcon size={14} />
        </button>
      </div>
      {downloadError && (
        <span role="alert">{`${alt || 'The image'} could not download: ${downloadError}`}</span>
      )}
    </>
  );
}
