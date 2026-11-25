// File Explorer's uploads and their progress, from stock Fluent parts (ADR 0093).
import { Button, makeStyles, ProgressBar, Text, tokens } from '@fluentui/react-components';
import { Dismiss20Regular } from '@fluentui/react-icons';
import { useRef, useState } from 'react';
import type { UploadOptions } from './files-service';

const useStyles = makeStyles({
  upload: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(80px, 2fr) auto', alignItems: 'center', gap: tokens.spacingHorizontalS, padding: `0 ${tokens.spacingHorizontalS}` },
});

type Upload = { id: number; name: string; fraction: number; controller: AbortController };

/** Uploads into a folder ('' for workspace): each one's progress until it ends, and the browser's file chooser. */
export function useUploads(onUpload: (file: File, options: UploadOptions, folder: string) => Promise<string>, folder: string) {
  const [uploads, setUploads] = useState<readonly Upload[]>([]);
  const nextUpload = useRef(0);
  const upload = (chosenFiles: FileList | null) => {
    for (const each of chosenFiles ?? []) {
      const entry: Upload = { id: nextUpload.current++, name: each.name, fraction: 0, controller: new AbortController() };
      setUploads((all) => [...all, entry]);
      const onProgress = (fraction: number) => setUploads((all) => all.map((one) => (one.id === entry.id ? { ...one, fraction } : one)));
      const ended = () => setUploads((all) => all.filter(({ id }) => id !== entry.id));
      // The app says why an upload failed; the window only stops showing its progress.
      void onUpload(each, { onProgress, signal: entry.controller.signal }, folder).then(ended, ended);
    }
  };
  // The browser's file chooser: Fluent has no file picker part, so an input is made for each choice, never drawn.
  const chooseFiles = () => {
    const chooser = document.createElement('input');
    chooser.type = 'file';
    chooser.multiple = true;
    chooser.onchange = () => upload(chooser.files);
    chooser.click();
  };
  return { uploads, upload, chooseFiles };
}

/** Each upload's name, progress and Cancel. */
export function UploadRows({ uploads }: { uploads: readonly Upload[] }) {
  const styles = useStyles();
  return uploads.map(({ id, name, fraction, controller }) => (
    <div key={id} className={styles.upload}>
      <Text size={200} truncate wrap={false}>{name}</Text>
      <ProgressBar value={fraction} aria-label={`Uploading ${name}`} />
      <Button appearance="subtle" size="small" icon={<Dismiss20Regular />} aria-label={`Cancel upload ${name}`} title="Cancel upload" onClick={() => controller.abort()} />
    </div>
  ));
}
