import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { startMotos } from './moto-servers.js';

export default async function setup(project: TestProject) {
  const launcher = fileURLToPath(new URL('./moto_server.py', import.meta.url));
  let directory = dirname(launcher);
  let python = join(directory, 'templates/always-on/.venv/bin/python');
  while (!existsSync(python)) {
    const parent = dirname(directory);
    if (existsSync(join(directory, '.git')) || parent === directory) {
      throw new Error(`template Python interpreter not found above ${launcher}`);
    }
    directory = parent;
    python = join(directory, 'templates/always-on/.venv/bin/python');
  }
  return startMotos(project, python, launcher);
}
