"use client";

import { Fades } from "./motion";
import type { ComponentProps } from 'react';
import { defaultComponents } from 'streamdown';
import { InlineAlertLine } from './alert-line';
import { ReplyFileCard } from './reply-file-card';
import { linkedPath, type FilesPath } from './files-path';
import { useReplyFile } from './use-reply-file';

type LinkProps = ComponentProps<typeof defaultComponents.a>;

function FileAnchor({ link, style, ...props }: {
  link: LinkProps;
} & ComponentProps<"a">) {
  return <defaultComponents.a {...link} {...props} style={{ ...link.style, ...style }}>{link.children}</defaultComponents.a>;
}

const CITATION = /^\[(\d+)\]$/;

export function ReplyFileLink(props: LinkProps & { 'data-file-card'?: string }) {
  const path = props.href ? linkedPath(props.href) : null;
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

function FileLink({ path, ...props }: LinkProps & { path: FilesPath }) {
  const { file, download, downloadFailure } = useReplyFile(path);
  // The chat opens only once no link is loading (chat-opening.ts): its resolved state may take more lines.
  if (file === null) return <span data-reply-file-loading="">{props.children} (loading)</span>;
  return (
    <>
      <Fades>{file.status === 'ready' && (
        <FileAnchor
          link={props}
          ref={props.ref}
          inert={props.inert}
          href={file.url}
          onClick={download}
        />
      )}</Fades>
      <Fades>{downloadFailure !== null && (
        <InlineAlertLine>
          {props.children} could not download: {downloadFailure}
        </InlineAlertLine>
      )}</Fades>
    </>
  );
}
