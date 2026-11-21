import { findChromium } from '../src/local-chromium.js';

/** The Chromium a test launches: the one the Chat Service would find (CI sets BOTCUBE_CHROMIUM_PATH). */
export function testChromiumPath(): string {
  return findChromium(process.env);
}
