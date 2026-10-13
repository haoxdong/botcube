import { copyFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const destination = process.argv[2];
if (!destination) throw new Error('The browser tool staging directory is required');
const binaryDirectory = join(destination, 'node_modules/agent-browser/bin');

await Promise.all(['x64', 'arm64'].map(async (architecture) => {
  const name = `agent-browser-linux-${architecture}`;
  const staged = join(destination, name);
  await copyFile(join(binaryDirectory, name), staged);
  await chmod(staged, 0o755);
}));

const licenseDirectory = join(destination, 'licenses/agent-browser');
await mkdir(licenseDirectory, { recursive: true });
await copyFile(join(destination, 'node_modules/agent-browser/LICENSE'), join(licenseDirectory, 'LICENSE'));
await Promise.all(['LICENSE-axe-core.txt', 'LICENSE-axe-core-THIRD-PARTY.txt'].map(async (name) => {
  await copyFile(join(destination, 'node_modules/agent-browser/cli/src/native/a11y', name), join(licenseDirectory, name));
}));
