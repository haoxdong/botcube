import { describe, expect, it } from 'vitest';
import { picture, pictureUrl } from './pictures.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pngAtSize = (bytes: number) => {
  const data = Buffer.from(PNG.slice('data:image/png;base64,'.length), 'base64');
  return `data:image/png;base64,${Buffer.concat([data, Buffer.alloc(bytes - data.length)]).toString('base64')}`;
};

// Complete GIF supplied as an inline image by RFC 2397 section 4:
// https://www.rfc-editor.org/rfc/rfc2397.html#section-4
const GIF = 'data:image/gif;base64,R0lGODdhMAAwAPAAAAAAAP///ywAAAAAMAAwAAAC8IyPqcvt3wCcDkiLc7C0qwyGHhSWpjQu5yqmCYsapyuvUUlvONmOZtfzgFzByTB10QgxOR0TqBQejhRNzOfkVJ+5YiUqrXF5Y5lKh/DeuNcP5yLWGsEbtLiOSpa/TPg7JpJHxyendzWTBfX0cxOnKPjgBzi4diinWGdkF8kjdfnycQZXZeYGejmJlZeGl9i2icVqaNVailT6F5iJ90m6mvuTS4OK05M0vDk0Q4XUtwvKOzrcd3iq9uisF81M1OIcR7lEewwcLp7tuNNkM3uNna3F2JQFo97Vriy/Xl4/f1cf5VWzXyym7PHhhx4dbgYKAAA7';

describe('Public picture parsing', () => {
  it('keeps a picture of exactly 256 KiB', () => {
    const url = pngAtSize(256 * 1024);
    const saved = picture(url, "The agent's picture");
    expect(saved.contentType).toBe('image/png');
    expect(saved.data.byteLength).toBe(262144);
    expect(pictureUrl(saved)).toBe(url);
  });

  it('refuses one byte beyond 256 KiB with the advertised size', () => {
    expect(() => picture(pngAtSize(256 * 1024 + 1), "The agent's picture"))
      .toThrowError(expect.objectContaining({ status: 413, detail: "The agent's picture must be at most 256 KB" }));
  });

  it.each([
    ['a URL containing a data URL', `https://example.com/${PNG}`],
    ['a data URL with nonbase64 trailing text', `${PNG}!`],
  ])('refuses %s as a whole base64 data URL', (_name, value) => {
    // RFC 2397 section 3 defines a data URL beginning data:; the public API accepts base64 only.
    expect(() => picture(value, "The agent's picture"))
      .toThrowError(expect.objectContaining({ status: 422, detail: "The agent's picture must be a base64 data URL" }));
  });

  it.each([
    ['a text file named as PNG', 'data:image/png;base64,aGVsbG8='],
    // Existing resized-picture mock from botcube/ui/web/src/app/page.test.tsx.
    // RIFF alone is not a WebP container: https://developers.google.com/speed/webp/docs/riff_container
    ['a RIFF prefix without WebP form type', 'data:image/webp;base64,UklGRg=='],
  ])('refuses %s as an unsupported image', (_name, value) => {
    expect(() => picture(value, "The agent's picture"))
      .toThrowError(expect.objectContaining({ status: 415, detail: "The agent's picture must be a PNG, JPEG, WebP, or GIF image" }));
  });

  it('keeps the complete inline GIF from the data URL specification', () => {
    const saved = picture(GIF, "The agent's picture");
    expect(saved.contentType).toBe('image/gif');
    expect(pictureUrl(saved)).toBe(GIF);
  });
});
