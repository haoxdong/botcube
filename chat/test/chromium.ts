import { findChromium } from '../src/local-chromium.js';

/** The Chromium a test launches: TEMPLATE_TEST_CHROMIUM_PATH (CI's), or the one the Chat Service would find. */
export function testChromiumPath(): string {
  return process.env.TEMPLATE_TEST_CHROMIUM_PATH || findChromium(process.env);
}
