import { positiveInteger } from './config.js';
import { HttpError } from './cartridge.js';

/** A small image an account keeps, such as its agent's picture: its bytes and their image type. */
export interface Picture {
  contentType: string;
  data: Uint8Array;
}

/** The largest picture an account keeps: well under DynamoDB's 400 KB item limit. */
const MAX_PICTURE_BYTES = positiveInteger(process.env, 'BOTCUBE_MAX_PICTURE_BYTES', 256 * 1024);

/** Each accepted image type, by the bytes its files start with. */
const SIGNATURES: readonly { contentType: string; matches: (data: Buffer) => boolean }[] = [
  { contentType: 'image/png', matches: (data) => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { contentType: 'image/jpeg', matches: (data) => data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  { contentType: 'image/gif', matches: (data) => data.subarray(0, 4).toString('latin1') === 'GIF8' },
  {
    contentType: 'image/webp',
    matches: (data) => data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/**
 * The picture a base64 `data:` URL holds, typed by its bytes rather than its claimed type;
 * a 422 when it is no such URL, a 413 when it is too large, and a 415 when it is no accepted image.
 */
export function picture(value: unknown, label: string): Picture {
  const match = typeof value === 'string' ? /^data:[^,;]*;base64,([A-Za-z0-9+/]*={0,2})$/.exec(value) : null;
  if (match === null) throw new HttpError(422, `${label} must be a base64 data URL`);
  const data = Buffer.from(match[1] ?? '', 'base64');
  if (data.length > MAX_PICTURE_BYTES) throw new HttpError(413, `${label} must be at most ${MAX_PICTURE_BYTES / 1024} KB`);
  const signature = SIGNATURES.find(({ matches }) => matches(data));
  if (signature === undefined) throw new HttpError(415, `${label} must be a PNG, JPEG, WebP, or GIF image`);
  return { contentType: signature.contentType, data };
}

/** The picture as a `data:` URL, which an `<img>` shows without another authenticated request. */
export function pictureUrl({ contentType, data }: Picture): string {
  return `data:${contentType};base64,${Buffer.from(data).toString('base64')}`;
}

/** The picture as the attributes of the DynamoDB item that keeps it. */
export function pictureItem({ contentType, data }: Picture): Record<string, unknown> {
  return { content_type: contentType, data };
}

/** The picture a DynamoDB item keeps, or null without the item. */
export function pictureFromItem(item: Record<string, unknown> | undefined): Picture | null {
  return item ? { contentType: item.content_type as string, data: item.data as Uint8Array } : null;
}
