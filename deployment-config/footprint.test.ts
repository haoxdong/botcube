import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { footprint, formatFootprint } from './footprint.js';
import { loadDeployment } from './load.js';

const example = (name: string) => fileURLToPath(new URL(`../examples/${name}/deployment-config.json`, import.meta.url));

it("names the enterprise example's OIDC issuer host among its egress hosts", () => {
  const printed = formatFootprint(footprint(loadDeployment(example('enterprise')).config));

  expect(printed).toContain('  login.example.com\n');
  expect(printed).not.toContain('<identity.issuer host>');
});
