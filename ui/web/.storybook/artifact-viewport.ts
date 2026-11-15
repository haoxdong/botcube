import { page } from 'vitest/browser';

export async function artifactViewport() {
  if (window.innerWidth <= 640) await page.viewport(390, 844);
}
