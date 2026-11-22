import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { botcubeConfig } from '../config/schema.js';

const json = (path: string): object => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const fixture = (name: string): object => ({ ...json('required-keys.json'), ...json(`fixtures/config-section-defaults/${name}`) });

it('fills the nested defaults of sections given with only their required fields, as the Python loaders must', () => {
  expect(botcubeConfig.parse(fixture('config.json'))).toEqual(fixture('parsed.json'));
});
