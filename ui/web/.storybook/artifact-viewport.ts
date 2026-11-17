export async function artifactViewport() {
  if (window.innerWidth > 640 || window.innerWidth === 390) return;
  const { page } = await import('vitest/browser');
  await page.viewport(390, 844);
}
