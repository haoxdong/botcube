import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { cartridgeIdentity } from '../lib/cartridge.js';
import { parkingTransition } from '../lib/parking-transition.js';

const identity = cartridgeIdentity(path.resolve(__dirname, '../../../../templates/always-on/deploy'));

test('bundles the transition when cdk.out sits inside ecs/cdk, as in the deploy workflow', () => {
  const infraRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-infra-'));
  try {
    for (const file of ['ecs/parking_transition.py', 'ecs/verify/live.py', 'ecs/parking/dispatcher.mjs', 'ecs/cdk/lib/stack.ts', 'ecs/verify/__pycache__/live.pyc']) {
      fs.mkdirSync(path.dirname(path.join(infraRoot, file)), { recursive: true });
      fs.writeFileSync(path.join(infraRoot, file), '');
    }
    fs.writeFileSync(path.join(infraRoot, 'identity-defaults.json'), '{}');
    const app = new App({ outdir: path.join(infraRoot, 'ecs/cdk/cdk.out') });
    parkingTransition(new Stack(app, 'Parking', { env: { account: identity.aws.account, region: identity.aws.region } }), infraRoot, identity);
    const outdir = app.synth().directory;
    const asset = fs.readdirSync(outdir).find(name => fs.existsSync(path.join(outdir, name, 'ecs')));
    if (!asset) throw new Error(`No transition asset in ${outdir}`);
    const bundled = (relative: string) => fs.existsSync(path.join(outdir, asset, relative));
    expect([bundled('ecs/parking_transition.py'), bundled('ecs/verify/live.py'), bundled('cartridge/identity.json'), bundled('identity-defaults.json')]).toEqual([true, true, true, true]);
    expect([bundled('ecs/cdk'), bundled('ecs/parking'), bundled('ecs/verify/__pycache__')]).toEqual([false, false, false]);
  } finally {
    fs.rmSync(infraRoot, { recursive: true, force: true });
  }
});
