import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const DESCRIPTION = 'A model for complex analysis and everyday work with extended reasoning and coding capabilities.';
const PICKER_MODELS = [
  ['openai-plan:gpt-6.1-sol', 'GPT-6.1-Sol'],
  ['openai-plan:gpt-6-astra', 'GPT-6-Astra'],
  ['openai-plan:gpt-6-sol', 'GPT-6-Sol'],
  ['openai-plan:gpt-6-luna', 'GPT-6-Luna'],
  ['openai-plan:gpt-5.6-sol', 'GPT-5.6-Sol'],
  ['sonnet-4.6', 'Sonnet 4.6'],
  ['opus-4.6', 'Opus 4.6'],
  ['opus-5.5', 'Opus 5.5'],
  ['deepseek-v3.2', 'DeepSeek V3.2'],
].map(([key, label]) => ({ key, label, provider: 'openai', description: DESCRIPTION }));
const VISIBLE_MODELS = ['GPT-6.1-Sol', 'GPT-6-Astra', 'Opus 5.5', 'DeepSeek V3.2'];
const PICKER = '.chat-model-picker [data-slot="popover-trigger"]';

/** @param {string} label */
const startingWith = (label) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

/**
 * @param {import('playwright').Page} page @param {string} base @param {string} name @param {string} chatService
 * @param {boolean} [twoLines] whether a phone types two lines first, which puts the picker beside Send
 */
export async function checkModelPicker(page, base, name, chatService, twoLines = true) {
  await page.route(`${chatService}/agent/models`, (route) => route.fulfill({
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': new URL(base).origin, 'access-control-allow-credentials': 'true' },
    body: JSON.stringify({ models: PICKER_MODELS }),
  }));
  // The desktop incident was 1280×633. Keep the phone width/device, but exercise a short viewport there too.
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('Model picker viewport missing');
  await page.setViewportSize({ width: viewport.width > 767 ? 1280 : viewport.width, height: 633 });
  await page.goto(base);
  // A phone's one-line composer has no picker, as in the Claude app; two lines put it beside Send.
  if (viewport.width <= 767) {
    const composer = page.locator('.chat-composer textarea:not([readonly])');
    if (twoLines) await composer.fill('What moved US rates?\nAnd why?');
    else await composer.click();
  }
  const pill = page.locator(PICKER);
  await pill.waitFor();
  await pill.click();
  const card = page.getByRole('dialog', { name: 'Model and effort' });
  const list = page.getByRole('listbox');
  const openList = async () => {
    await card.getByRole('combobox', { name: /^Model / }).click();
    await list.waitFor();
  };
  const boundsFailure = await checkPickerBounds(page, card, name);
  if (boundsFailure !== null) return boundsFailure;
  await openList();
  const listFailure = await checkListBounds(list);
  if (listFailure !== null) return listFailure;
  await page.keyboard.press('Escape');
  await list.waitFor({ state: 'detached' });
  const choiceFailure = await chooseEachModel(page, list, openList);
  if (choiceFailure !== null) return choiceFailure;
  await openList();
  await list.getByRole('option', { name: startingWith('GPT-6.1-Sol') }).click();
  await page.getByRole('button', { name: 'Model GPT-6.1-Sol, reasoning Medium', exact: true }).waitFor();
  await openList();
  await list.getByRole('option', { name: startingWith('GPT-6-Astra') }).click();
  await page.getByRole('button', { name: 'Model GPT-6-Astra, reasoning Medium', exact: true }).waitFor();
  const slider = card.getByRole('slider', { name: 'Effort' });
  await slider.focus();
  await slider.press('ArrowRight');
  await page.getByRole('button', { name: 'Model GPT-6-Astra, reasoning High', exact: true }).waitFor();
  await card.getByRole('button', { name: 'Reset effort' }).click();
  await page.getByRole('button', { name: 'Model GPT-6-Astra, reasoning Medium', exact: true }).waitFor();
  await page.locator('textarea').click();
  await card.waitFor({ state: 'detached' });
  if (await pill.getAttribute('aria-label') !== 'Model GPT-6-Astra, reasoning Medium') return 'outside dismissal changed the selected model';
  await pill.click();
  await pill.press('Escape');
  await card.waitFor({ state: 'detached' });
  if (await pill.getAttribute('aria-label') !== 'Model GPT-6-Astra, reasoning Medium') return 'Escape dismissal changed the selected model';
  await page.locator('textarea').fill(Array.from({ length: 12 }, () => 'A multiline draft').join('\n'));
  await pill.click();
  const grown = await card.boundingBox();
  if (!grown || grown.y < 0 || grown.y + grown.height > 633) return 'growing composer pushes the model card outside the viewport';
  await openList();
  await list.getByRole('option', { name: startingWith('GPT-6.1-Sol') }).click();
  await page.getByRole('button', { name: 'Model GPT-6.1-Sol, reasoning Medium', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  return null;
}

/** @param {import('playwright').Page} page @param {import('playwright').Locator} list @param {() => Promise<void>} openList */
async function chooseEachModel(page, list, openList) {
  for (const label of VISIBLE_MODELS) {
    // eslint-disable-next-line no-await-in-loop -- each ordinary click must select and read back its own model
    await openList();
    const option = list.getByRole('option', { name: startingWith(label) });
    // eslint-disable-next-line no-await-in-loop -- each ordinary click must select and read back its own model
    await option.scrollIntoViewIfNeeded();
    // eslint-disable-next-line no-await-in-loop -- the scrolled target itself must be fully visible before clicking
    const visible = await option.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const container = node.closest('[role="listbox"]')?.getBoundingClientRect();
      return container !== undefined && rect.top >= container.top && rect.bottom <= container.bottom && rect.left >= 0 && rect.right <= innerWidth;
    });
    if (!visible) return `model option ${label} is not fully visible after scrolling`;
    // eslint-disable-next-line no-await-in-loop -- uniqueness is part of the selection control
    if (await option.count() !== 1) return `model option ${label} is not unique`;
    // eslint-disable-next-line no-await-in-loop -- real browser hit testing, never a forced or synthetic click
    await option.click();
    // eslint-disable-next-line no-await-in-loop -- read the actual controlled picker after the transition
    await page.getByRole('button', { name: `Model ${label}, reasoning Medium`, exact: true }).waitFor();
  }
  return null;
}

/** @param {import('playwright').Page} page @param {import('playwright').Locator} card @param {string} name */
async function checkPickerBounds(page, card, name) {
  const bounds = await card.evaluate((node) => {
    const { top, bottom, left, right } = node.getBoundingClientRect();
    const composer = document.querySelector('.chat-composer')?.getBoundingClientRect();
    return { top, bottom, left, right, width: right - left, composerTop: composer?.top, composerRight: composer?.right, composerWidth: composer?.width, viewportHeight: innerHeight, viewportWidth: innerWidth };
  });
  process.stdout.write(`${name} model picker ${JSON.stringify(bounds)}\n`);
  if (process.env.LAYOUT_SCREENSHOTS) {
    await mkdir(process.env.LAYOUT_SCREENSHOTS, { recursive: true });
    await card.evaluate(async (node) => { await Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)); });
    await page.screenshot({ path: join(process.env.LAYOUT_SCREENSHOTS, `model-picker-${name.replace(/[^a-z0-9]+/gi, '-')}.png`) });
  }
  if (bounds.top < 0 || bounds.bottom > bounds.viewportHeight || bounds.left < 0 || bounds.right > bounds.viewportWidth) return `PICKER_OUTSIDE_VIEWPORT ${JSON.stringify(bounds)}`;
  if (bounds.composerTop === undefined || bounds.bottom > bounds.composerTop - 8 + 0.5 || Math.abs(bounds.right - (bounds.composerRight ?? 0)) > 1) return `PICKER_NOT_ABOVE_COMPOSER ${JSON.stringify(bounds)}`;
  if (bounds.width > 288.5 || (bounds.composerWidth !== undefined && bounds.width >= bounds.composerWidth)) return `PICKER_TOO_WIDE ${JSON.stringify(bounds)}`;
  return null;
}

/** @param {import('playwright').Locator} list */
async function checkListBounds(list) {
  const bounds = await list.evaluate((node) => {
    const { top, bottom, left, right } = node.getBoundingClientRect();
    return { top, bottom, left, right, viewportHeight: innerHeight, viewportWidth: innerWidth, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: getComputedStyle(node).overflowY };
  });
  if (bounds.top < 0 || bounds.bottom > bounds.viewportHeight || bounds.left < 0 || bounds.right > bounds.viewportWidth) return `PICKER_LIST_OUTSIDE_VIEWPORT ${JSON.stringify(bounds)}`;
  const options = await list.getByRole('option').allTextContents();
  if (JSON.stringify(options) !== JSON.stringify(VISIBLE_MODELS.map((label) => `${label}${DESCRIPTION}`))) return `PICKER_MODELS ${JSON.stringify(options)}`;
  return null;
}
