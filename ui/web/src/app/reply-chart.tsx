'use client';

import { useEffect, useState, type ComponentProps } from 'react';
import { Arrives } from "./motion";
import { PlotlyChart } from '../components/plotly-chart';
import { isFigureName } from '../components/plotly-figure';
import { linkedPath, type FilesPath } from './files-path';
import { ReplyImage } from './reply-image';
import { useReplyFile } from './use-reply-file';
import { viewport } from '../design-system/viewport';
import { AlertLine } from './alert-line';

/**
 * A reply's image: a `.plotly.json` file the agent embeds as `![<caption>](<file path>)` draws as a live chart,
 * and anything else shows as the picture it is (ReplyImage).
 */
export function ReplyVisual(props: ComponentProps<'img'>) {
  const path = typeof props.src === 'string' ? linkedPath(props.src) : null;
  if (path !== null && isFigureName(path)) return <ReplyChart path={path} label={props.alt || path} />;
  return <ReplyImage {...props} />;
}

/**
 * The width a reply's chart is drawn at before it is scaled to the bubble: about twice a phone bubble's 290px, and
 * 1.25 times a desktop bubble's 573px, so the chart's text sits under the reply's own.
 */
export const replyChartDrawWidth = () => (viewport() === 'phone' ? 573 : 720);

/**
 * One of the agent's `.plotly.json` files as a live chart across the reply's width, its box there from the first frame
 * at a chart's height; it fetches the file from its short-lived URL in Files.
 */
export function ReplyChart({ path, label }: { path: FilesPath; label: string }) {
  const { file } = useReplyFile(path);
  const url = file?.status === 'ready' ? file.url : null;
  const [text, setText] = useState<{ url: string; text: string } | { url: string; failure: string } | null>(null);
  useEffect(() => {
    if (url === null) return;
    const gone = new AbortController();
    void fetch(url, { signal: gone.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setText({ url, text: await response.text() });
      })
      .catch((cause: unknown) => {
        if (!gone.signal.aborted) setText({ url, failure: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => gone.abort();
  }, [url]);
  const failure =
    file !== null && file.status !== 'ready' ? file.reason : text !== null && 'failure' in text ? text.failure : null;
  const state = failure !== null ? 'failed' : text !== null && 'text' in text ? 'chart' : 'loading';
  return (
    <span className="reply-chart" data-loading={state === 'loading' ? '' : undefined}>
      <Arrives as="span" state={state} className="reply-chart-body">
        {failure !== null ? (
          <AlertLine className="reply-image-error">{`${label} could not load: ${failure}`}</AlertLine>
        ) : text !== null && 'text' in text ? (
          <PlotlyChart key={text.text} text={text.text} title={label} drawWidth={replyChartDrawWidth()} />
        ) : null}
      </Arrives>
    </span>
  );
}
