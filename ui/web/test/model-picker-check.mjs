import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
].map(([key, label]) => ({ key, label, provider: 'openai', description: 'A model for complex analysis and everyday work with extended reasoning and coding capabilities.' }));
const VISIBLE_MODELS = ['GPT-6.1-Sol', 'GPT-6-Astra', 'Opus 5.5', 'DeepSeek V3.2'];

/** @param {import('playwright').Page} page @param {string} base @param {string} name @param {string} chatService */
export async function checkModelPicker(page, base, name, chatService) {
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
  if (viewport.width <= 767) await page.locator('.copilotKitInput.picker-ready textarea').click();
  const pill = page.locator('.chat-model-picker .mep-pill');
  await pill.waitFor();
  await pill.click();
  const dropdown = page.locator('.mep-dropdown');
  const boundsFailure = await checkPickerBounds(page, dropdown, name);
  if (boundsFailure !== null) return boundsFailure;
  for (const label of VISIBLE_MODELS) {
    const option = dropdown.locator('.mep-option').filter({ has: page.getByText(label, { exact: true }) });
    // eslint-disable-next-line no-await-in-loop -- each ordinary click must select and read back its own model
    await option.scrollIntoViewIfNeeded();
    // eslint-disable-next-line no-await-in-loop -- the scrolled target itself must be fully visible before clicking
    const visible = await option.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const container = node.parentElement?.getBoundingClientRect();
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
  await dropdown.locator('.mep-option').filter({ has: page.getByText('GPT-6.1-Sol', { exact: true }) }).click();
  await page.getByRole('button', { name: 'Model GPT-6.1-Sol, reasoning Medium', exact: true }).waitFor();
  await dropdown.locator('.mep-option').filter({ has: page.getByText('GPT-6-Astra', { exact: true }) }).click();
  await page.getByRole('button', { name: 'Model GPT-6-Astra, reasoning Medium', exact: true }).waitFor();
  await dropdown.locator('.mep-option:not(.mep-back)').filter({ has: page.getByText('Effort', { exact: true }) }).click();
  await dropdown.locator('.mep-option').filter({ has: page.getByText('High', { exact: true }) }).click();
  await page.getByRole('button', { name: 'Model GPT-6-Astra, reasoning High', exact: true }).waitFor();
  await dropdown.locator('.mep-option:not(.mep-back)').filter({ has: page.getByText('Effort', { exact: true }) }).click();
  await dropdown.locator('.mep-option').filter({ has: page.getByText('Medium', { exact: true }) }).click();
  await page.getByRole('button', { name: 'Model GPT-6-Astra, reasoning Medium', exact: true }).waitFor();
  await page.locator('textarea').click();
  await dropdown.waitFor({ state: 'detached' });
  if (await pill.getAttribute('aria-label') !== 'Model GPT-6-Astra, reasoning Medium') return 'outside dismissal changed the selected model';
  await pill.click();
  await pill.press('Escape');
  await dropdown.waitFor({ state: 'detached' });
  if (await pill.getAttribute('aria-label') !== 'Model GPT-6-Astra, reasoning Medium') return 'Escape dismissal changed the selected model';
  await page.locator('textarea').fill(Array.from({ length: 12 }, () => 'A multiline draft').join('\n'));
  await pill.click();
  const grown = await dropdown.boundingBox();
  if (!grown || grown.y < 0 || grown.y + grown.height > 633) return 'growing composer pushes the model menu outside the viewport';
  await dropdown.locator('.mep-option').filter({ has: page.getByText('GPT-6.1-Sol', { exact: true }) }).click();
  await page.getByRole('button', { name: 'Model GPT-6.1-Sol, reasoning Medium', exact: true }).waitFor();
  await pill.press('Escape');
  return null;
}

/** @param {import('playwright').Page} page @param {import('playwright').Locator} dropdown @param {string} name */
async function checkPickerBounds(page, dropdown, name) {
  const bounds = await dropdown.evaluate((node) => {
    const { top, bottom, left, right } = node.getBoundingClientRect();
    return { top, bottom, left, right, width: right - left, composerWidth: document.querySelector(".copilotKitInput")?.getBoundingClientRect().width, viewportHeight: innerHeight, viewportWidth: innerWidth, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflowY: getComputedStyle(node).overflowY };
  });
  process.stdout.write(`${name} model picker ${JSON.stringify(bounds)}\n`);
  if (process.env.LAYOUT_SCREENSHOTS) {
    await mkdir(process.env.LAYOUT_SCREENSHOTS, { recursive: true });
    await dropdown.evaluate(async (node) => { await Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)); });
    await page.screenshot({ path: join(process.env.LAYOUT_SCREENSHOTS, `model-picker-${name.replace(/[^a-z0-9]+/gi, '-')}.png`) });
  }
  if (bounds.top < 0 || bounds.bottom > bounds.viewportHeight || bounds.left < 0 || bounds.right > bounds.viewportWidth) return `PICKER_OUTSIDE_VIEWPORT ${JSON.stringify(bounds)}`;
  if (bounds.scrollHeight > bounds.clientHeight && !/auto|scroll/.test(bounds.overflowY)) return 'PICKER_NOT_SCROLLABLE';
  if (bounds.width > 280.5 || (bounds.composerWidth !== undefined && bounds.width >= bounds.composerWidth)) return `PICKER_TOO_WIDE ${JSON.stringify(bounds)}`;
  const labels = await dropdown.locator('.mep-option-name').allTextContents();
  if (JSON.stringify(labels) !== JSON.stringify([...VISIBLE_MODELS, 'Effort'])) return `PICKER_MODELS ${JSON.stringify(labels)}`;
  return null;
}
