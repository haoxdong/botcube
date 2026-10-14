'use client';

import { useState, type ComponentProps, type MouseEvent } from 'react';
import { defaultComponents } from 'streamdown';
import { agentFiles } from './agent-files';
import { replyFilePath } from './reply-file-path';
import { useReplyFile } from './use-reply-file';

const CITATION = /^\[(\d+)\]$/;
const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function ReplyFileLink(
  props: ComponentProps<typeof defaultComponents.a>
) {
  const path = props.href ? replyFilePath(props.href) : null;
  const { file } = useReplyFile(path);
  const [downloadError, setDownloadError] = useState<{
    path: string;
    reason: string;
  } | null>(null);
  if (!path) {
    const cited =
      typeof props.children === 'string'
        ? CITATION.exec(props.children)?.[1]
        : undefined;
    if (cited === undefined) return <defaultComponents.a {...props} />;
    return (
      <defaultComponents.a {...props} data-citation="">
        <span data-citation-bracket="">[</span>
        {cited}
        <span data-citation-bracket="">]</span>
      </defaultComponents.a>
    );
  }
  if (file === null) return <span>{props.children} (loading)</span>;
  const error =
    downloadError?.path === path
      ? downloadError.reason
      : file.status !== 'ready'
        ? file.reason
        : null;
  if (file.status !== 'ready' || error !== null)
    return (
      <span role="alert">
        {props.children} could not download: {error}
      </span>
    );
  return (
    <defaultComponents.a
      {...props}
      href={file.url}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        void agentFiles
          .url(path)
          .then((url) => window.location.assign(url))
          .catch((error: unknown) =>
            setDownloadError({ path, reason: reason(error) })
          );
      }}
    />
  );
}
