import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { cubeApp } from './cube.mjs';

/** @param {string[]} args */
const pnpm = args => execFileSync('pnpm', ['--dir', cubeApp, ...args], { stdio: 'inherit' });
pnpm(['install', '--frozen-lockfile', '--filter', 'botcube-infra-agentcore-cdk']);
pnpm(['run', 'build']);

mkdirSync(new URL('./dist/bin/', import.meta.url), { recursive: true });
for (const file of ['bin/cdk.js', 'cube.mjs']) {
  copyFileSync(new URL(`./${file}`, import.meta.url), new URL(`./dist/${file}`, import.meta.url));
}
