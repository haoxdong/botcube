import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

/** @param {import('playwright').Page} page @param {string} [screen] */
export async function checkPhoneComposer(page, screen = 'WebKit iPhone 15') {
  if (screen !== 'WebKit iPhone 15') return null;
  const iosRules = await page.evaluate(() => [...document.styleSheets].filter(sheet => !sheet.href || new URL(sheet.href).origin === location.origin).flatMap(sheet => [...sheet.cssRules]).flatMap(rule => rule instanceof CSSSupportsRule && rule.conditionText.includes('-webkit-touch-callout') ? [[...rule.cssRules].map(child => child.cssText).join('\n')] : []).join('\n'));
  const style = iosRules ? await page.addStyleTag({ content: iosRules }) : null;
  const textarea = page.locator('textarea:not([readonly])').first();
  await page.locator('.app-chat:not(.app-chat-opening) .copilotKitMessage').last().waitFor();
  const originalDraft = await textarea.inputValue();
  const safeTop = await page.evaluate(() => document.documentElement.style.getPropertyValue('--app-safe-top'));
  const safeArea = await page.evaluate(() => ({ value: document.documentElement.style.getPropertyValue('--app-safe-bottom'), priority: document.documentElement.style.getPropertyPriority('--app-safe-bottom') }));
  const scrolling = await page.locator('.copilotKitMessage').last().evaluateHandle(row => {
    let element = row.parentElement;
    while (element && !(/auto|scroll/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight)) element = element.parentElement;
    const scroller = element ?? document.scrollingElement;
    if (!scroller) throw new Error('Missing message scroll container');
    return scroller;
  });
  const originalScroll = await scrolling.evaluate(element => element.scrollTop);
  const failures = [];
  /** @param {string} name */
  const capture = async name => {
    if (!process.env.LAYOUT_SCREENSHOTS) return;
    await mkdir(process.env.LAYOUT_SCREENSHOTS, { recursive: true });
    const clip = await page.evaluate(() => {
      if (!visualViewport) throw new Error('Missing visual viewport');
      return { x: 0, y: visualViewport.offsetTop, width: window.innerWidth, height: visualViewport.height };
    });
    await page.screenshot({ path: `${process.env.LAYOUT_SCREENSHOTS}/composer-${name}.png`, clip });
  };
  const read = () => page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="copilot-input-overlay"]');
    const input = overlay?.querySelector('[data-testid="copilot-chat-input"]');
    const wrapper = overlay?.querySelector('[data-copilotkit]');
    if (!overlay || !input || !wrapper || !visualViewport) throw new Error('Phone composer needs its input, wrapper and visual viewport');
    const pill = document.querySelector('.chat-header-name');
    if (!pill) throw new Error('Missing header name');
    const backing = document.querySelector('.chat-composer-backing');
    return {
      composer: overlay.getBoundingClientRect().toJSON(),
      capsule: input.getBoundingClientRect().toJSON(),
      blur: (() => {
        const shell = document.querySelector('.app-chat')?.closest('.app-shell');
        if (!shell) throw new Error('Missing chat shell');
        const style = getComputedStyle(shell, '::before');
        return { filter: style.backdropFilter, background: style.backgroundImage, mask: style.maskImage, top: shell.getBoundingClientRect().top + parseFloat(style.top), height: parseFloat(style.height) };
      })(),
      layoutHeight: window.innerHeight,
      visualHeight: visualViewport.height,
      safeBottom: getComputedStyle(document.documentElement).getPropertyValue('--app-safe-bottom').trim(),
      visibleBottom: visualViewport.height + visualViewport.offsetTop,
      wrapperBackground: getComputedStyle(wrapper).backgroundColor,
      backingHeight: backing?.getBoundingClientRect().height ?? 0,
      typed: input.querySelector('textarea')?.getBoundingClientRect().toJSON(),
      header: document.querySelector('.chat-header')?.getBoundingClientRect().toJSON(),
      pillBackground: getComputedStyle(pill).backgroundColor,
      jump: document.querySelector('[data-testid="copilot-scroll-to-bottom"]')?.getBoundingClientRect().toJSON(),
    };
  });
  /** @param {Awaited<ReturnType<typeof read>>} state */
  const transparent = (state) => {
    if (state.wrapperBackground !== 'rgba(0, 0, 0, 0)') failures.push('full-width composer wrapper paints a band');
    if (state.backingHeight > 0) failures.push('page backing covers messages below the composer');
  };
  try {
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--app-safe-bottom', '34px');
      document.documentElement.style.setProperty('--app-safe-top', '47px');
    });
    await page.evaluate(scroller => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true }));
      scroller.scrollBy(0, -500);
    }, scrolling);
    await page.waitForTimeout(100);
    const down = await read();
    transparent(down);
    if (!(await scrolling.evaluate(element => element === document.scrollingElement))) failures.push('the document must own phone chat scrolling');
    if ((await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY)) !== 'none') failures.push('the phone page must not rubber-band, which drags the fixed header and menu');
    await capture('down');
    const readingTop = await scrolling.evaluate(element => element.scrollTop);
    await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Plugins', exact: true }).click();
    await page.getByRole('heading', { name: 'Plugins', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
    await page.getByRole('button', { name: 'Main Chat', exact: true }).click();
    await page.locator('.app-chat:not(.app-chat-opening) .copilotKitMessage').last().waitFor();
    await page.waitForTimeout(400);
    assert.equal(await scrolling.evaluate(element => element.scrollTop), readingTop, 'Plugins must preserve the reading position');
    await textarea.fill('Keyboard visibility regression');
    await page.evaluate(() => {
      const viewport = visualViewport;
      if (!viewport) throw new Error('Missing visual viewport');
      document.documentElement.style.setProperty('--app-safe-bottom', '0px');
      Object.defineProperty(viewport, 'height', { configurable: true, value: window.innerHeight - 300 });
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 0 });
      viewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(400);
    const up = await read();
    if (up.layoutHeight !== down.layoutHeight || up.visualHeight !== down.visualHeight - 300) failures.push('Keyboard emulation must shrink only the visual viewport by 300px');
    transparent(up);
    await capture('keyboard');
    if (Math.abs(up.composer.bottom - up.visibleBottom) > 1 || !up.typed || up.typed.bottom > up.visibleBottom || up.typed.top < 0) failures.push('composer must meet the keyboard with typed text visible');
    if (failures.length > 0) assert.fail(JSON.stringify({ down, up, failures }));
    await page.evaluate(() => {
      const viewport = visualViewport;
      if (!viewport) throw new Error('Missing visual viewport');
      Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: 120 });
      viewport.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(100);
    const panned = await read();
    await capture('panned');
    if (Math.abs(panned.composer.bottom - panned.visibleBottom) > 1) failures.push('composer loses the keyboard during Safari pan');
    if (!panned.typed || panned.typed.top < 120 || panned.typed.bottom > panned.visibleBottom) failures.push('typed text leaves the panned viewport');
    if (!panned.header || Math.abs(panned.header.top - 120) > 1 || panned.pillBackground !== 'rgba(255, 255, 255, 0.8)') failures.push('header must follow Safari pan with its specified frosted name backing');
    if (!panned.jump || panned.jump.bottom > panned.capsule.top) failures.push('jump control is covered by the keyboard');
    const scroll = await page.evaluate(async scroller => {
      const viewport = visualViewport;
      if (!viewport) throw new Error('Missing visual viewport');
      /** @type {{travel: number, shift: number | null, blank: boolean}[]} */
      const frames = [];
      const start = scroller.scrollTop;
      await new Promise(resolve => {
        const tick = () => {
        scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true }));
        const before = scroller.scrollTop;
        scroller.scrollBy(0, -20);
        const anchor = [...document.querySelectorAll('.copilotKitMessage')].find(row => {
          const rect = row.getBoundingClientRect();
          return rect.top < viewport.offsetTop + viewport.height && rect.bottom > viewport.offsetTop;
        });
        const expectedTop = anchor?.getBoundingClientRect().top;
        requestAnimationFrame(() => setTimeout(() => {
        const visibleRows = [...document.querySelectorAll('.copilotKitMessage')].filter(row => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > viewport.offsetTop && rect.top < viewport.offsetTop + viewport.height;
        });
        const blank = visibleRows.length === 0 || visibleRows.some(row => {
          const style = getComputedStyle(row);
          return style.visibility !== 'visible' || Number(style.opacity) < 1;
        });
        frames.push({ travel: before - scroller.scrollTop, shift: anchor?.isConnected && expectedTop !== undefined ? anchor.getBoundingClientRect().top - expectedTop : null, blank });
        if (frames.length < 20) tick();
        else resolve(null);
        }, 0));
        };
        tick();
      });
      return { start, end: scroller.scrollTop, frames };
    }, scrolling);
    if (scroll.frames.filter(frame => frame.travel !== 0).length < 15 || scroll.frames.some(frame => frame.blank || frame.shift === null || Math.abs(frame.shift) > 1)) failures.push('scrolling rebounds after paint');
    await page.getByTestId('copilot-scroll-to-bottom').click();
    await page.waitForFunction(element => element.scrollHeight - element.clientHeight - element.scrollTop <= 2, scrolling);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      if (!visualViewport) throw new Error('Missing visual viewport');
      Object.defineProperty(visualViewport, 'height', { configurable: true, value: window.innerHeight - 360 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(element => element.scrollHeight - element.clientHeight - element.scrollTop <= 2, scrolling);
    const gapAfterShrink = await scrolling.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
    if (gapAfterShrink > 2) failures.push(`keyboard shrink loses the newest message by ${gapAfterShrink}px`);
    assert.deepEqual(failures, [], JSON.stringify({down, up, panned, scroll, gapAfterShrink, failures}));
    const result = { down, up, panned, scroll, gapAfterShrink };
    if (process.env.LAYOUT_SCREENSHOTS) await writeFile(`${process.env.LAYOUT_SCREENSHOTS}/composer-geometry.json`, JSON.stringify(result, null, 2));
    return result;
  } finally {
    await page.evaluate(safeArea => {
      if (safeArea.value) document.documentElement.style.setProperty('--app-safe-bottom', safeArea.value, safeArea.priority);
      else document.documentElement.style.removeProperty('--app-safe-bottom');
      if (!visualViewport) return;
      Reflect.deleteProperty(visualViewport, 'height');
      Reflect.deleteProperty(visualViewport, 'offsetTop');
      visualViewport.dispatchEvent(new Event('resize'));
    }, safeArea);
    await page.evaluate(value => {
      if (value) document.documentElement.style.setProperty('--app-safe-top', value);
      else document.documentElement.style.removeProperty('--app-safe-top');
    }, safeTop);
    await textarea.fill(originalDraft);
    await scrolling.evaluate((element, top) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 500, bubbles: true }));
      element.scrollTo({ top, behavior: 'instant' });
    }, originalScroll);
    await scrolling.dispose();
    if (style) await style.evaluate(element => element.parentNode?.removeChild(element));
  }
}
