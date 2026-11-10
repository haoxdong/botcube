import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const botcube = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('the template web UI plugin', () => {
  // A second copy holds its own React context: the plugin's views then find no CopilotKitProvider in the app.
  it("resolves the app's own CopilotKit", () => {
    const copilotKit = (root: string) => realpathSync(`${root}/node_modules/@copilotkit/react-core`);
    expect(copilotKit(resolve(botcube, 'templates/always-on/ui/web'))).toBe(copilotKit(resolve(botcube, 'ui/web')));
  });
});
