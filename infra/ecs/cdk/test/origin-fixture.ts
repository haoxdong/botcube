import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'origin-assets-'));
export const caCertificate = { bucket: 'origin-trust', key: 'origin-pull.pem', versionId: 'version-3' };
export const originProviderPath = path.join(repositoryRoot, 'origin-provider');
fs.mkdirSync(originProviderPath);
fs.writeFileSync(path.join(originProviderPath, 'handler.py'), 'def on_event(event, context):\n    return {}\n');
fs.copyFileSync(path.join(__dirname, '../../origin-provider/parked-worker.mjs'), path.join(originProviderPath, 'parked-worker.mjs'));
