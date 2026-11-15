import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const require = createRequire(resolve(root, 'botcube/ui/web/package.json'));

/** @param {import('playwright').Browser} browser @param {string} screen */
export async function checkBubbleShadow(browser, screen = 'Chromium 1440×900') {
  if (screen !== 'Chromium 1440×900') return;
  const css = await Promise.all(['tokens.css', 'chat.css'].map(file => {
    const path = `botcube/ui/web/src/app/${file}`;
    return process.env.SHADOW_CSS_REF
      ? execFileSync('git', ['show', `${process.env.SHADOW_CSS_REF}:${path}`], { cwd: root, encoding: 'utf8' })
      : readFile(resolve(root, path), 'utf8');
  }));
  const palette = await readFile(require.resolve('@radix-ui/colors/gray.css'), 'utf8');
  const failures = await Promise.all([1440, 390].flatMap(width =>
    /** @type {const} */ (['light', 'dark']).map(colorScheme => checkScheme(browser, width, colorScheme, `${palette}\n${css.join('\n')}`))));
  assert.deepEqual(failures.flat(), [], 'Rounded bubble shadows must match their uncontained paint');
}

/** @param {import('playwright').Browser} browser @param {number} width @param {'light' | 'dark'} colorScheme @param {string} css */
async function checkScheme(browser, width, colorScheme, css) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
  try {
    await page.setContent(`<style>${css}
      .copilotKitMessages { display: flex; flex-direction: column; padding-top: 80px; }
      .reply-chart { display: block; height: 180px; }
    </style><main class="copilotKitMessages">
      <div class="copilotKitMessage copilotKitAssistantMessage" data-contained data-opened>
        <div class="cpk:prose"><div class="chat-markdown"><span class="reply-chart"><svg viewBox="0 0 500 180" width="100%" height="180" role="img" aria-label="Spot history"><path d="M20 140L90 110L160 130L230 60L300 80L370 20L440 40" fill="none" stroke="blue"/></svg></span></div></div>
      </div>
      <div class="copilotKitMessage copilotKitUserMessage" data-opened>What changed?</div>
      <div class="copilotKitMessage copilotKitAssistantMessage" data-contained data-opened>
        <div class="cpk:prose"><div class="chat-markdown"><p>The spot rate rose over the month.</p></div></div>
      </div>
      <div class="copilotKitMessage copilotKitUserMessage" data-opened>Thanks.</div>
    </main>`);
    const chart = await checkAnswer(page, 0, `${width}-${colorScheme}-chart`);
    const text = await checkAnswer(page, 1, `${width}-${colorScheme}-text`);
    return [...chart, ...text];
  } finally {
    await page.close();
  }
}

/** @param {import('playwright').Page} page @param {number} index @param {string} label */
async function checkAnswer(page, index, label) {
  const row = page.locator('.copilotKitAssistantMessage').nth(index);
  const box = await row.locator('.chat-markdown').boundingBox();
  assert(box, 'The answer bubble must render');
  const left = await checkCorner(page, row, box, 'left', label);
  const right = await checkCorner(page, row, box, 'right', label);
  return [...left, ...right];
}

/** @param {import('playwright').Page} page @param {import('playwright').Locator} row @param {{ x: number, y: number, width: number, height: number }} box @param {'left' | 'right'} corner @param {string} answer */
async function checkCorner(page, row, box, corner, answer) {
  const width = page.viewportSize()?.width;
  assert(width, 'Corner comparison needs a viewport');
  const x = corner === 'left' ? box.x : box.x + box.width;
  const clip = { x: Math.max(0, Math.min(width - 64, Math.floor(x) - 32)), y: Math.floor(box.y + box.height) - 32, width: 64, height: 64 };
  const actual = await page.screenshot({ clip });
  await row.evaluate(element => { element.style.contentVisibility = 'visible'; });
  const reference = await page.screenshot({ clip });
  await row.evaluate(element => { element.style.removeProperty('content-visibility'); });
  const label = `${answer}-${corner}`;
  if (process.env.LAYOUT_SCREENSHOTS) {
    await mkdir(process.env.LAYOUT_SCREENSHOTS, { recursive: true });
    await Promise.all([
      writeFile(resolve(process.env.LAYOUT_SCREENSHOTS, `${label}-actual.png`), actual),
      writeFile(resolve(process.env.LAYOUT_SCREENSHOTS, `${label}-reference.png`), reference),
    ]);
  }
  const result = await page.evaluate(async ({ actual, reference, corner }) => {
    const pixels = async (/** @type {string} */ png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Corner comparison needs a canvas');
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const current = await pixels(actual);
    const original = await pixels(reference);
    const offset = (63 * 64 + (corner === 'left' ? 0 : 63)) * 4;
    const background = getComputedStyle(document.body).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number);
    return {
      difference: current.reduce((total, value, i) => total + Number(value !== original[i]), 0),
      exterior: Array.from(current.slice(offset, offset + 3)),
      background,
    };
  }, { actual: actual.toString('base64'), reference: reference.toString('base64'), corner });
  assert.deepEqual(result.exterior, result.background, `${label}: outside the shadow must match the page background`);
  return result.difference === 0 ? [] : [`${label}: ${result.difference} clipped color channels`];
}
