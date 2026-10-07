'use client';

import {
  useEffect,
  useState,
  type ComponentProps,
  type MouseEvent,
} from 'react';
import { defaultComponents } from 'streamdown';
import { webUiPlugin } from '@cartridge-ui';
import { replyFilePath } from './reply-file-path';

type FileLink =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; reason: string };
const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function ReplyFileLink(
  props: ComponentProps<typeof defaultComponents.a>
) {
  const fileUrl = webUiPlugin.fileUrl;
  const path = props.href && fileUrl ? replyFilePath(props.href) : null;
  const [file, setFile] = useState<FileLink>({ status: 'loading' });
  useEffect(() => {
    if (!path || !fileUrl) return;
    let current = true;
    setFile({ status: 'loading' });
    fileUrl(path).then(
      (url) => current && setFile({ status: 'ready', url }),
      (error: unknown) =>
        current && setFile({ status: 'error', reason: reason(error) })
    );
    return () => {
      current = false;
    };
  }, [path, fileUrl]);
  if (!path || !fileUrl) return <defaultComponents.a {...props} />;
  if (file.status === 'loading') return <span>{props.children} (loading)</span>;
  if (file.status === 'error')
    return (
      <span role="alert">
        {props.children} could not download: {file.reason}
      </span>
    );
  return (
    <defaultComponents.a
      {...props}
      href={file.url}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        void fileUrl(path)
          .then((url) => window.location.assign(url))
          .catch((error: unknown) =>
            setFile({ status: 'error', reason: reason(error) })
          );
      }}
    />
  );
}
