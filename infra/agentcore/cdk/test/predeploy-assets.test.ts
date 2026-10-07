import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stageAgentCoreDockerPrerequisites } from '../lib/predeploy-assets';

const projectRoots = new Set<string>();
const sourcePath = '../harness/deepagents';

afterEach(() => {
  for (const projectRoot of projectRoots) {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
  projectRoots.clear();
});

function makeProject(dockerfileText?: string): { projectRoot: string; hook: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcore-predeploy-'));
  const projectRoot = path.join(tempRoot, 'botcube', 'infra');
  const sourceDir = path.join(projectRoot, sourcePath);
  const hook = path.join(tempRoot, 'bot', 'deploy', 'stage-tools.sh');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/usr/bin/env bash\n');
  if (dockerfileText !== undefined) {
    fs.writeFileSync(path.join(sourceDir, 'Dockerfile'), dockerfileText);
  }
  projectRoots.add(tempRoot);
  return { projectRoot, hook };
}

test('runs the Cartridge hook before packaging a Docker context that copies tool assets', () => {
  const { projectRoot, hook } = makeProject('FROM scratch\nCOPY .tool-dist/ ./\n');
  const repositoryRoot = path.resolve(projectRoot, '../..');
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];

  const staged = stageAgentCoreDockerPrerequisites(
    { runtimes: [{ build: 'Container', codeLocation: `${sourcePath}/` }] },
    projectRoot,
    (command, args, options) => calls.push({ command, args, cwd: options.cwd }),
    repositoryRoot,
    hook
  );

  expect(staged).toBe(true);
  expect(calls).toEqual([{ command: hook, args: [], cwd: repositoryRoot }]);
});

test('runs the hook with the default runner from the build root', () => {
  const { projectRoot, hook } = makeProject('FROM scratch\nCOPY .tool-dist/ ./\n');
  fs.writeFileSync(hook, '#!/bin/sh\npwd > staged-from\n');
  fs.chmodSync(hook, 0o755);
  const buildRoot = fs.realpathSync(path.resolve(projectRoot, '../..'));

  stageAgentCoreDockerPrerequisites(
    { runtimes: [{ build: 'Container', codeLocation: `${sourcePath}/` }] },
    projectRoot,
    undefined,
    buildRoot,
    hook
  );

  expect(fs.readFileSync(path.join(buildRoot, 'staged-from'), 'utf8').trim()).toBe(buildRoot);
});

test('a spec without runtimes needs no staging', () => {
  const { projectRoot, hook } = makeProject();

  expect(stageAgentCoreDockerPrerequisites({}, projectRoot, undefined, projectRoot, hook)).toBe(false);
});

test('does not run a hook when the image has no staged tools', () => {
  const { projectRoot, hook } = makeProject('FROM scratch\nCOPY src/ ./src/\n');
  const calls: string[] = [];

  expect(
    stageAgentCoreDockerPrerequisites(
      { runtimes: [{ build: 'Container', codeLocation: `${sourcePath}/` }] },
      projectRoot,
      command => calls.push(command),
      projectRoot,
      hook
    )
  ).toBe(false);
  expect(calls).toEqual([]);
});

test('does not inspect non-container runtime Dockerfiles', () => {
  const { projectRoot, hook } = makeProject('FROM scratch\nCOPY .tool-dist/ ./\n');
  expect(
    stageAgentCoreDockerPrerequisites(
      { runtimes: [{ build: 'CodeZip', codeLocation: `${sourcePath}/` }] },
      projectRoot,
      undefined,
      projectRoot,
      hook
    )
  ).toBe(false);
});

test('fails loudly when a container runtime Dockerfile is missing', () => {
  const { projectRoot, hook } = makeProject();
  expect(() =>
    stageAgentCoreDockerPrerequisites(
      { runtimes: [{ build: 'Container', codeLocation: `${sourcePath}/` }] },
      projectRoot,
      undefined,
      projectRoot,
      hook
    )
  ).toThrow(/Dockerfile not found/);
});

test('fails loudly when a tool-staging hook is missing', () => {
  const { projectRoot, hook } = makeProject('FROM scratch\nCOPY .tool-dist/ ./\n');
  fs.rmSync(hook);
  expect(() =>
    stageAgentCoreDockerPrerequisites(
      { runtimes: [{ build: 'Container', codeLocation: `${sourcePath}/` }] },
      projectRoot,
      undefined,
      projectRoot,
      hook
    )
  ).toThrow(/tool-staging hook is missing/);
});

test('fails loudly when a container runtime has no codeLocation', () => {
  const { projectRoot, hook } = makeProject();
  expect(() =>
    stageAgentCoreDockerPrerequisites({ runtimes: [{ build: 'Container' }] }, projectRoot, undefined, projectRoot, hook)
  ).toThrow(new Error('AgentCore Container runtime is missing codeLocation; cannot inspect Dockerfile prerequisites'));
});

test('fails loudly when staged tools are required but the Cartridge has no hook', () => {
  const { projectRoot } = makeProject('FROM scratch\nCOPY .tool-dist/ ./\n');
  expect(() =>
    stageAgentCoreDockerPrerequisites(
      { runtimes: [{ build: 'Container', codeLocation: `${sourcePath}/` }] },
      projectRoot,
      undefined,
      projectRoot
    )
  ).toThrow(new Error('AgentCore Dockerfile requires .tool-dist, but the Cartridge has no tool-staging hook'));
});
