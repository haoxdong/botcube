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

it('lists the resources a Deployment Config runs its OIDC provider on', () => {
  const { config } = loadDeployment(example('enterprise'));
  if (config.identity.kind !== 'oidc') throw new Error('The enterprise example signs in with OIDC');
  const resources = [{ type: 'AWS::Example::Directory', name: 'example-users' }, { type: 'AWS::Example::Mailer', name: 'example.com' }];

  const printed = formatFootprint(footprint({ ...config, identity: { ...config.identity, resources } }));

  expect(printed).toContain('Resources\n  AWS::Example::Directory example-users\n  AWS::Example::Mailer example.com\n');
});
