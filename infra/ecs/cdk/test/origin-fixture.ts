import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-assets-'));
export const caPath = 'origin-pull-ca.crt';
export const originProviderPath = path.join(repositoryRoot, 'origin-provider');
fs.writeFileSync(path.join(repositoryRoot, caPath), 'synthetic origin certificate');
fs.mkdirSync(originProviderPath);
fs.writeFileSync(path.join(originProviderPath, 'handler.py'), 'def on_event(event, context):\n    return {}\n');
