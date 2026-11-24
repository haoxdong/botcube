import type { Screen } from '../src/design-system/screens';
import { insetTokens } from '../src/design-system/screens';

export async function resizeScreen({ width, height }: Pick<Screen, 'width' | 'height'>) {
  const { page } = await import('vitest/browser');
  await page.viewport(width, height);
}

export function atScreen<Context>(screen: Screen, play: (context: Context) => Promise<void> | void) {
  return async (context: Context) => {
    const { onTestFinished } = await import('vitest');
    const { innerWidth: width, innerHeight: height } = window;
    const root = document.documentElement.style;
    const tokens = Object.entries(insetTokens(screen));
    await resizeScreen(screen);
    const frame = () => new Promise(requestAnimationFrame);
    await frame();
    await frame();
    for (const [token, value] of tokens) root.setProperty(token, value);
    document.documentElement.dataset.screen = screen.name;
    const restore = async () => {
      delete document.documentElement.dataset.screen;
      for (const [token] of tokens) root.removeProperty(token);
      await resizeScreen({ width, height });
    };
    // The screen stays until the test's after-hooks have run, so a capture shows the story at its screen.
    onTestFinished(restore);
    await play(context);
  };
}
