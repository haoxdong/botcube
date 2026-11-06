import { closeSidebar, sidebarSettled } from '../../../../scripts/web-layout-sidebar.mjs';

export const scrollHalfwayUp = () => {
  let scroller = document.querySelector('.copilotKitMessage')?.parentElement ?? null;
  while (scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
  scroller ??= /** @type {HTMLElement | null} */ (document.scrollingElement);
  scroller?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
  scroller?.scrollTo({ top: Math.round(scroller.scrollTop / 2), behavior: 'instant' });
};

const PAGE_HOLD = () => {
  let row = document.querySelector('[data-page-hold-row]');
  if (row === null) {
    row = [...document.querySelectorAll('.copilotKitMessage')].find((message) => message.getBoundingClientRect().top > 200) ?? null;
    row?.setAttribute('data-page-hold-row', '');
  }
  const chat = /** @type {Element} */ (document.querySelector('.app-chat'));
  const shell = /** @type {Element} */ (document.querySelector('.app-shell:not([hidden])'));
  const card = shell.getBoundingClientRect();
  const style = getComputedStyle(shell);
  const inset = (/** @type {string} */ side) => parseFloat(style.getPropertyValue(`border-${side}-width`)) + parseFloat(style.getPropertyValue(`padding-${side}`));
  return {
    scrollY: Math.round(window.scrollY),
    chatScrolls: /auto|scroll/.test(getComputedStyle(chat).overflowY) && chat.scrollHeight > chat.clientHeight,
    row: Math.round(row?.getBoundingClientRect().top ?? -1),
    header: Math.round(document.querySelector('.chat-header')?.getBoundingClientRect().top ?? -1),
    composer: Math.round(document.querySelector('[data-testid="copilot-input-overlay"]')?.getBoundingClientRect().bottom ?? -1),
    card: { top: Math.round(card.top), height: Math.round(card.height) },
    content: { top: Math.round(card.top + inset('top')), bottom: Math.round(card.bottom - inset('bottom')) },
    screenHeight: window.screen.height,
    height: window.innerHeight,
    width: window.innerWidth,
  };
};

const DYNAMIC_ISLAND_STATUS_BAR_HEIGHT = 62;

/** @param {import('playwright').Page} page */
export async function checkPageScroll(page) {
  if (await page.evaluate(() => window.innerWidth > 640)) return null;
  await page.evaluate(scrollHalfwayUp);
  await page.waitForTimeout(300);
  const before = await page.evaluate(PAGE_HOLD);
  if (before.scrollY === 0 || before.chatScrolls) return "phone chat must scroll the page";
  if (before.header !== 0 || before.composer > before.height) return "phone controls scrolled away";
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await page.locator('.sidebar-expanded').waitFor();
  await sidebarSettled(page);
  const open = await page.evaluate(PAGE_HOLD);
  if (open.row !== before.row || open.header !== 0 || open.composer > open.height || open.content.top !== 0 || open.content.bottom !== open.height) return "open drawer displaced the chat or controls";
  const below = Math.max(0, open.screenHeight - open.height - DYNAMIC_ISLAND_STATUS_BAR_HEIGHT);
  if (open.card.top + open.card.height - open.height !== below) return `drawer bottom must extend ${below}px past Safari viewport`;
  if (open.card.top >= 0 || open.scrollY === 0) return "open drawer lacks the scrolled Safari runway";
  await closeSidebar(page, open.width);
  await page.locator('.sidebar-collapsed').waitFor();
  await sidebarSettled(page);
  const closed = await page.evaluate(PAGE_HOLD);
  if (closed.scrollY !== before.scrollY || closed.row !== before.row) return "drawer closure moved the chat";
  return null;
}

