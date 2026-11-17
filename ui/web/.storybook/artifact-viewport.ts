export async function artifactViewport() {
  if (window.innerWidth > 640 || window.innerWidth === 390) return;
  const { page } = await import('vitest/browser');
  await page.viewport(390, 844);
}

export async function crossPhoneBreakpoint(check: () => Promise<void>) {
  const { page } = await import('vitest/browser');
  const { innerWidth: width, innerHeight: height } = window;
  const sizes: [number, number][] = [width > 640 ? [390, 844] : [1440, 900], [width, height]];
  for (const [w, h] of sizes) {
    // eslint-disable-next-line no-await-in-loop -- the window crosses one way, then back
    await page.viewport(w, h);
    // eslint-disable-next-line no-await-in-loop -- each width is checked before the next resize
    await check();
  }
}
