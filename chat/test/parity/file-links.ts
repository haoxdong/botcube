import { uploadTo } from '../../../ui/web/src/computer/files-upload.js';

export const uploadFileLink = (url: string, body: string): Promise<void> => uploadTo(
  url, new File([body], 'upload'), { onProgress: () => undefined, signal: new AbortController().signal },
);
