import { ok as assert } from 'node:assert';
import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

const manifest = findPackageJSON('.', pathToFileURL(__filename));
assert(manifest, 'The ECS CDK module must be inside its package');
export const cdkPackageRoot = dirname(manifest);
