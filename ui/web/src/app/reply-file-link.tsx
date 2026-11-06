"use client";

import { m as motionElement } from "framer-motion";
import { Presence, presenceMotion } from "./collapse";
import type { ComponentProps } from 'react';
import { defaultComponents } from 'streamdown';
import { ReplyFileCard } from './reply-file-card';
import { replyFilePath } from './reply-file-path';
import { useReplyFile } from './use-reply-file';

const MotiondefaultComponentsa = motionElement.create(defaultComponents.a);

type LinkProps = ComponentProps<typeof defaultComponents.a>;

const CITATION = /^\[(\d+)\]$/;

export function ReplyFileLink(props: LinkProps & { 'data-file-card'?: string }) {
  const path = props.href ? replyFilePath(props.href) : null;
  if (path && props['data-file-card'] !== undefined)
    return <ReplyFileCard path={path}>{props.children}</ReplyFileCard>;
  if (path) return <FileLink {...props} path={path} />;
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

function FileLink({ path, ...props }: LinkProps & { path: string }) {
  const { file, download, downloadFailure } = useReplyFile(path);
  // The chat opens only once no link is loading (chat-opening.ts): its resolved state may take more lines.
  if (file === null) return <span data-reply-file-loading="">{props.children} (loading)</span>;
  return (
    <>
      <Presence>{file.status === 'ready' && (
        <MotiondefaultComponentsa {...presenceMotion}
          {...props}
          href={file.url}
          onClick={download}
        />
      )}</Presence>
      <Presence>{downloadFailure !== null && (
        <motionElement.span {...presenceMotion} role="alert">
          {props.children} could not download: {downloadFailure}
        </motionElement.span>
      )}</Presence>
    </>
  );
}
