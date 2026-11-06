import assert from 'node:assert/strict';

/** @param {import('playwright').BrowserContext} context @param {string} base @param {string} chatService */
export async function checkServerTurn(context, base, chatService) {
  await checkServerTurnChat(context, base, chatService, false);
  return checkServerTurnChat(context, base, chatService, true);
}

/** @param {import('playwright').BrowserContext} context @param {string} base @param {string} chatService @param {boolean} sideChat */
async function checkServerTurnChat(context, base, chatService, sideChat) {
  const page = await context.newPage();
  const id = sideChat ? 'side-layout' : 'main-layout';
  const url = new URL(base);
  if (sideChat) url.searchParams.set('chat', id);
  const cors = { 'access-control-allow-origin': new URL(base).origin, 'access-control-allow-credentials': 'true' };
  const started = new Date(Date.now() - 6000).toISOString();
  const messages = [
    { id: 'server-question', role: 'user', content: 'Read the rates.' },
    { id: 'server-work', role: 'assistant', content: 'Reading rates.', toolCalls: [{ id: 'server-tool', type: 'function', function: { name: 'execute', arguments: '{"command":"acme search rates"}' } }] },
  ];
  let running = true;
  let stoppable = false;
  let refuseStop = true;
  let releaseStop = () => {};
  let stopRequested = deferred();
  await page.route(`${chatService}${sideChat ? `/threads/${id}` : '/main-chat'}`, (route) => route.fulfill({
    contentType: 'application/json', headers: cors,
    body: JSON.stringify({ id, messages, running, runningSince: started, ...(stoppable ? { runId: 'server-run' } : {}) }),
  }));
  await page.route(`${chatService}/threads/${id}/stop`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' } });
    const gate = deferred();
    releaseStop = () => gate.resolve();
    stopRequested.resolve();
    await gate.promise;
    return route.fulfill({ status: refuseStop ? 503 : 200, contentType: 'application/json', headers: cors, body: JSON.stringify(refuseStop ? { error: 'Stop unavailable' } : {}) });
  });
  try {
    await page.addInitScript(() => {
      localStorage.clear();
      /** @type {string[]} */
      const titles = [];
      Object.assign(window, { serverTurnTitles: titles });
      const sample = () => {
        for (const title of document.querySelectorAll('.worklog-title')) {
          if (title.checkVisibility({ visibilityProperty: true })) titles.push(title.textContent ?? '');
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto(url.href);
    const chat = page.locator('.app-chat:not(.app-chat-opening)');
    await chat.locator('.copilotKitInput.picker-ready').waitFor();
    const title = chat.locator('.worklog-title').last();
    const preparing = await title.textContent();
    assert.match(preparing ?? '', /^Working/, 'a server Turn without a Stop runId must read Working');
    assert.equal(await chat.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => Reflect.get(window, 'serverTurnTitles').some((/** @type {string} */ text) => text.startsWith('Worked'))), false, 'the kept chat must not show a running Turn as Worked');
    stoppable = true;
    const stop = chat.getByRole('button', { name: 'Stop', exact: true });
    await stop.waitFor();
    const requested = page.waitForRequest((request) => request.url().endsWith(`/threads/${id}/stop`) && request.method() === 'POST');
    await stop.click();
    await requested;
    await stopRequested.promise;
    assert.match(await title.textContent() ?? '', /^Working/, 'a pending Stop must not finish the Worklog');
    releaseStop();
    await page.getByRole('alert').filter({ hasText: 'stop' }).first().waitFor();
    assert.match(await title.textContent() ?? '', /^Working/, 'a refused Stop must not finish the Worklog');
    await stop.waitFor();
    refuseStop = false;
    stopRequested = deferred();
    const retried = page.waitForRequest((request) => request.url().endsWith(`/threads/${id}/stop`) && request.method() === 'POST');
    await stop.click();
    await retried;
    await stopRequested.promise;
    assert.match(await title.textContent() ?? '', /^Working/);
    running = false;
    releaseStop();
    await page.waitForFunction(() => [...document.querySelectorAll('.app-chat:not(.app-chat-opening) .worklog-title')].some((node) => node.textContent?.startsWith('Worked')));
    assert.equal(await stop.count(), 0);
    messages.splice(1);
    running = true;
    stoppable = false;
    await page.reload();
    await chat.locator('.copilotKitInput.picker-ready').waitFor();
    assert.match(await title.textContent() ?? '', /^Working/, 'a running Turn with no saved steps needs a live Worklog');
    return null;
  } finally {
    releaseStop();
    await page.close();
  }
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise((done) => { resolve = () => done(undefined); });
  return { promise, resolve };
}
