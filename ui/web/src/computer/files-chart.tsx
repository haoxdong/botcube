'use client';

import { m as motionElement } from 'framer-motion';
import { useEffect, useState } from 'react';
import { Presence, presenceMotion, Swap } from '../app/collapse';
import { PlotlyChart } from '../components/plotly-chart';
import { isFigureName } from '../components/plotly-figure';

/** Whether Files opens a file, by its name, as a live chart rather than downloading it. */
export const opensAsChart = isFigureName;

/** The `.plotly.json` file open in Files' place, if any, fading in over the listing and out on Close. */
export function FilesChart({ file, fileUrl, onDownload, onClose }: {
  file: { path: string; name: string } | null;
  fileUrl: (path: string) => Promise<string>;
  onDownload: (path: string) => void;
  onClose: () => void;
}) {
  return (
    <Presence>{file !== null && (
      <motionElement.section {...presenceMotion} key={file.path} className="agent-computer-files-chart" aria-label={file.name}>
        <ChartFile path={file.path} name={file.name} fileUrl={fileUrl} onDownload={() => onDownload(file.path)} onClose={onClose} />
      </motionElement.section>
    )}</Presence>
  );
}

/**
 * A `.plotly.json` file live in Files, under a bar with its name, Download and Close; Close brings the listing
 * back. It fetches the file from a short-lived URL to it.
 */
function ChartFile({ path, name, fileUrl, onDownload, onClose }: {
  path: string;
  name: string;
  fileUrl: (path: string) => Promise<string>;
  onDownload: () => void;
  onClose: () => void;
}) {
  const [shown, setShown] = useState<{ text: string } | { failure: string } | null>(null);
  useEffect(() => {
    const gone = new AbortController();
    fileUrl(path)
      .then((url) => fetch(url, { signal: gone.signal }))
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setShown({ text: await response.text() });
      })
      .catch((cause: unknown) => {
        if (!gone.signal.aborted) setShown({ failure: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => gone.abort();
  }, [path, fileUrl]);
  return (
    <>
      <div className="agent-computer-files-chart-bar">
        <span>{name}</span>
        <button type="button" onClick={onDownload}>Download</button>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      <Swap state={shown === null ? 'loading' : 'text' in shown ? 'chart' : 'failed'} className="agent-computer-files-chart-body">
        {shown === null ? null : 'text' in shown ? (
          <PlotlyChart text={shown.text} title={name} />
        ) : (
          <p className="agent-computer-error" role="alert">{`${name} could not load: ${shown.failure}`}</p>
        )}
      </Swap>
    </>
  );
}
