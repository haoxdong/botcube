import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { deploymentConfig } from '../deployment-config/schema.js';

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`fixtures/deployment-config-section-defaults/${name}`, import.meta.url), 'utf8'));

it('fills the nested defaults of sections given with only their required fields, as the Python loaders must', () => {
  expect(deploymentConfig.parse(fixture('config.json'))).toEqual(fixture('parsed.json'));
});
