import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { main } from './footprint-cli.js';

const publicExample = fileURLToPath(new URL('../examples/public/deployment-config.json', import.meta.url));
const botcube = (...args: string[]) => {
  const printed = { stdout: '', stderr: '' };
  const status = main(args, { stdout: (text) => { printed.stdout += text; }, stderr: (text) => { printed.stderr += text; } });
  return { status, ...printed };
};
const runtimeSection = (printed: string) => /^Created at runtime\n((?: .*\n)*)/m.exec(printed)?.[1];

it('prints the access points the Chat Service creates at runtime by default', () => {
  const { status, stdout } = botcube('footprint', publicExample);
  expect(status).toBe(0);
  expect(runtimeSection(stdout)).toContain('elasticfilesystem:CreateAccessPoint on the Files file system');
});

it.each([['--files-access-point-mode', 'pool'], ['--files-access-point-mode=pool']])('prints none from the deploy-time pool (%s)', (...flag) => {
  const { status, stdout } = botcube('footprint', ...flag, publicExample);
  expect(status).toBe(0);
  expect(runtimeSection(stdout)).toBe('');
});

it.each([['--files-access-point-mode=shared'], ['--files-access-point-mode'], ['--unknown'], [publicExample]])('refuses %s as a usage error', (...flag) => {
  const { status, stderr } = botcube('footprint', publicExample, ...flag);
  expect(status).toBe(2);
  expect(stderr).toContain('--files-access-point-mode <runtime|pool>');
});

it('refuses a missing Deployment Config as a usage error', () => {
  expect(botcube('footprint').status).toBe(2);
});
