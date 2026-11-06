"use client";

import { Swap, Presence, presenceMotion } from "./collapse";

import { m as motionElement } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { fileExtension, isImageName } from '../components/file-type-icon';
import { isFigureName } from '../components/plotly-figure';
import { FileFace, reason } from './composer-files';
import { ReplyChart } from './reply-chart';
import { ReplyImage } from './reply-image';
import { useReplyFile } from './use-reply-file';

/**
 * A file in Files that a reply links to on a line of its own, as a card that downloads it: its type's icon, its name
 * and its kind, as a sent file's card shows them, and a PDF's first page above them. An image shows inline instead,
 * as ReplyImage shows it. The link's text names the card to a screen reader.
 */
export function ReplyFileCard({
  path,
  children,
}: {
  path: string;
  children: ReactNode;
}) {
  const name = decodeURIComponent(path.slice(path.lastIndexOf('/') + 1));
  const label = typeof children === 'string' ? children : name;
  // A Plotly figure shows as the live chart itself, as an embedded one does.
  if (isFigureName(name))
    return (
      <span className="reply-file-image">
        <ReplyChart path={path} label={label} />
      </span>
    );
  // An image shows as the picture itself, as the reply's own images show, rather than as a card, in the card's place.
  if (isImageName(name))
    return (
      <span className="reply-file-image">
        <ReplyImage src={path} alt={label} />
      </span>
    );
  return <FileCard key={path} path={path} name={name} label={label} />;
}

/**
 * The card itself, there from the first frame: only its href waits for the file's short-lived URL, and a click
 * downloads from a fresh one, as a link to a file does.
 */
function FileCard({
  path,
  name,
  label,
}: {
  path: string;
  name: string;
  label: string;
}) {
  const { file, download, downloadFailure, unavailable } = useReplyFile(path);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const url = file?.status === 'ready' ? file.url : null;
  const pdf = fileExtension(name) === 'pdf';
  // A PDF's page box stays the size it came at, so a page that cannot draw says why in its place rather than taking
  // the box away and moving every row under the card.
  const pageFailure =
    previewError !== null
      ? `${name} preview could not load: ${previewError}`
      : unavailable !== null
        ? `${name} could not download: ${unavailable}`
        : null;
  // Said in the page's box, a file's missing URL is not said again under the card.
  const shownBelow = pdf && downloadFailure === unavailable ? null : downloadFailure;
  return (
    <>
      <a
        aria-label={label}
        className="sent-file reply-file"
        data-preview={pdf ? '' : undefined}
        href={url ?? undefined}
        onClick={download}
      >
        <Presence>{pdf && (
          <motionElement.span {...presenceMotion} className="reply-file-preview">
            <Swap as="span" state={pageFailure === null ? "preview" : "failed"}>{pageFailure === null ? (
              <PdfFirstPage url={url} onFailed={setPreviewError} />
            ) : (
              <span className="reply-file-preview-error" role="alert">
                {pageFailure}
              </span>
            )}</Swap>
          </motionElement.span>
        )}</Presence>
        <FileFace name={name} />
      </a>
      <Presence>{shownBelow !== null && (
        <motionElement.p {...presenceMotion} role="alert">{`${name} could not download: ${shownBelow}`}</motionElement.p>
      )}</Presence>
    </>
  );
}

/**
 * A PDF's first page, drawn by pdf.js across its box once the file's `url` comes. pdf.js loads only here, so the chat
 * bundle does not carry it; it fetches the whole file in one GET, which the Files bucket's CORS lets the web origin make.
 */
function PdfFirstPage({
  url,
  onFailed,
}: {
  url: string | null;
  onFailed: (reason: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (url === null || element === null) return;
    const gone = new AbortController();
    let task: PDFDocumentLoadingTask | undefined;
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      if (gone.signal.aborted) return;
      // As pdfjs-dist's own webpack entry finds its worker: a URL the bundler (Next's webpack, Storybook's Vite) emits.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
      task = pdfjs.getDocument({ url, disableRange: true, disableStream: true });
      const page = await (await task.promise).getPage(1);
      // A card laid out with no width would draw a 0×0 page, blank with nothing to say why.
      if (element.clientWidth === 0) throw new Error('the card has no width');
      const viewport = page.getViewport({
        scale:
          (element.clientWidth * window.devicePixelRatio) /
          page.getViewport({ scale: 1 }).width,
      });
      element.width = Math.floor(viewport.width);
      element.height = Math.floor(viewport.height);
      await page.render({ canvas: element, viewport }).promise;
    })().catch((failure: unknown) => {
      if (!gone.signal.aborted) onFailed(reason(failure));
    });
    return () => {
      gone.abort();
      void task?.destroy();
    };
  }, [url, onFailed]);
  return <canvas ref={canvas} />;
}
