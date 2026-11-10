import assert from 'node:assert/strict';

/** @param {import('playwright').Page} page @param {string} base */
export async function checkFavicon(page, base) {
  const response = await page.request.get(new URL('/favicon.ico', base).href);
  assert.equal(response.status(), 200, 'GET /favicon.ico must succeed');
  assert.match(response.headers()['content-type'] ?? '', /^image\//, 'favicon must be an image');
  const body = await response.body();
  const dimensions = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/x-icon;base64,${data}`;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, body.toString('base64'));
  assert.ok(dimensions.every((size) => size > 0), 'favicon must decode in the browser');
}
