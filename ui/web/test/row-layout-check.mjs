import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** @param {import('playwright').Browser} browser @param {string} screen */
export async function checkRowLayout(browser, screen = 'Chromium 1440×900') {
  if (screen !== 'Chromium 1440×900') return;
  const css = await Promise.all(['tokens.css', 'chat.css'].map(file => readFile(new URL(`../src/app/${file}`, import.meta.url), 'utf8')));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    const content = `<p>${'The long end moved while the front end held. '.repeat(15)}</p>`.repeat(12);
    const rows = `<div class="copilotKitAssistantMessage"><div class="cpk:prose"><div class="chat-markdown">${content}<div class="late-content"></div></div></div></div>`;
    await page.setContent(`<style>${css.join('\n')}
      .sizing-reference, .sizing-reference * { contain: none !important; content-visibility: visible !important; }
      .sizing-reference > :not(:last-child) { display: flow-root; }
    </style><main class="copilotKitMessages">${rows.repeat(4)}</main><main class="copilotKitMessages sizing-reference">${rows.repeat(4)}</main>`);
    /** @param {string} label */
    const measure = async (label) => {
      const actual = page.locator('.copilotKitMessages:not(.sizing-reference) > div');
      for await (const [index, row] of (await actual.all()).entries()) {
        await row.scrollIntoViewIfNeeded();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const heights = await page.evaluate(index => [...document.querySelectorAll('.copilotKitMessages')].map(list => {
          const child = list.children[index];
          if (!child) throw new Error('The sizing fixture lost a row');
          return child.getBoundingClientRect().height;
        }), index);
        assert.equal(heights.length, 2, 'The sizing fixture needs a candidate and a control');
        assert.equal(heights[0], heights[1], `${label}: a revealed row must have its natural height`);
      }
      const sizes = await page.evaluate(() => [...document.querySelectorAll('.copilotKitMessages')].map(list => {
        const first = list.firstElementChild;
        const last = list.lastElementChild;
        if (!first || !last) throw new Error('The sizing fixture needs first and last rows');
        return {
          height: list.getBoundingClientRect().height,
          firstHeight: first.getBoundingClientRect().height,
          lastHeight: last.getBoundingClientRect().height,
          lastOffset: last.getBoundingClientRect().top - list.getBoundingClientRect().top,
        };
      }));
      const [actualSize, referenceSize] = sizes;
      assert(actualSize && referenceSize, 'The sizing fixture needs both lists');
      assert.deepEqual(actualSize, referenceSize, `${label}: visited rows must remember their natural dimensions`);
      return actualSize;
    };
    const initial = await measure('initial');
    await page.evaluate(() => {
      scrollTo(0, document.body.scrollHeight);
      for (const list of document.querySelectorAll('.copilotKitMessages')) {
        const earlier = document.createElement('div');
        earlier.setAttribute('data-chat-earlier', '');
        list.prepend(earlier);
      }
    });
    const sentinels = page.locator('[data-chat-earlier]');
    assert.deepEqual(await sentinels.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height)), [0, 0], 'An unseen history sentinel must reserve no placeholder space');
    await sentinels.evaluateAll(elements => elements.forEach(element => element.remove()));
    await page.setViewportSize({ width: 650, height: 900 });
    const narrow = await measure('narrow');
    assert.notEqual(narrow.height, initial.height, 'Narrowing must reflow the rows');
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.deepEqual(await measure('wide again'), initial, 'Widening must restore natural dimensions');
    await page.addStyleTag({ content: '.copilotKitMessages * { font-family: monospace !important; font-size: 20px !important; }' });
    const font = await measure('font changed');
    assert.notEqual(font.height, initial.height, 'New font metrics must change row dimensions');
    await page.evaluate(() => {
      for (const box of document.querySelectorAll('.copilotKitMessages > :first-child .late-content')) box.setAttribute('style', 'height: 137px');
    });
    const late = await measure('offscreen content grew');
    assert.equal(late.firstHeight - font.firstHeight, 137, 'A revealed row must include its late content');
    assert.equal(late.lastOffset - font.lastOffset, 137, 'Later rows must follow the revealed content height');
    await page.evaluate(() => {
      for (const row of document.querySelectorAll('.copilotKitMessages > :last-child')) row.append(document.createTextNode(' A streamed answer grows.'.repeat(200)));
    });
    const streaming = await measure('last row grew');
    assert(streaming.lastHeight > late.lastHeight, 'The last row must grow with the streamed answer');
    process.stdout.write('ok row layout: revealed row sizes match uncontained rendering after width, font, late content and streaming changes\n');
  } finally {
    await page.close();
  }
}
