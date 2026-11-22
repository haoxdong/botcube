import { IgnoreMode } from 'aws-cdk-lib';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { DockerImageCode } from 'aws-cdk-lib/aws-lambda';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface RuntimeSourceSpec {
  build?: string | undefined;
  codeLocation?: string | undefined;
  dockerfile?: string | undefined;
}

export interface AgentCoreDockerPrerequisiteSpec {
  runtimes?: RuntimeSourceSpec[];
}

interface CommandOptions {
  cwd: string;
  stdio: 'inherit';
}

type CommandRunner = (command: string, args: string[], options: CommandOptions) => void;

function runtimeDockerfilePath(projectRoot: string, runtime: RuntimeSourceSpec): string {
  if (!runtime.codeLocation) {
    throw new Error('AgentCore Container runtime is missing codeLocation; cannot inspect Dockerfile prerequisites');
  }
  return path.resolve(projectRoot, runtime.codeLocation, runtime.dockerfile ?? 'Dockerfile');
}

// A Dockerfile under .tool-dist/ is one the tool-staging hook writes, so it needs staging before it exists.
const stagedDockerfile = (runtime: RuntimeSourceSpec) => runtime.dockerfile?.startsWith('.tool-dist/') === true;

function requiresToolStaging(spec: AgentCoreDockerPrerequisiteSpec, projectRoot: string): boolean {
  return (spec.runtimes ?? []).some(runtime => {
    if (runtime.build !== 'Container') return false;
    if (stagedDockerfile(runtime)) return true;
    const dockerfilePath = runtimeDockerfilePath(projectRoot, runtime);
    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(`AgentCore Container runtime Dockerfile not found at ${dockerfilePath}`);
    }
    return fs.readFileSync(dockerfilePath, 'utf8').includes('.tool-dist');
  });
}

/** The bot's tool-staging hook: the `stage-tools.sh` its deploy root holds, as code beside its Dockerfiles; absent, none. */
export function toolStagingHook(deployRoot: string): string | undefined {
  const hook = path.join(deployRoot, 'stage-tools.sh');
  return fs.existsSync(hook) ? hook : undefined;
}

/** The checkout holding the deploy root, which the hook runs from: its git work tree. */
export function checkoutRoot(deployRoot: string): string {
  return execFileSync('git', ['-C', deployRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

export function stageAgentCoreDockerPrerequisites(
  spec: AgentCoreDockerPrerequisiteSpec,
  projectRoot: string,
  run: CommandRunner = execFileSync,
  buildRoot: string = projectRoot,
  toolStagingHook?: string
): boolean {
  if (!requiresToolStaging(spec, projectRoot)) {
    return false;
  }

  if (!toolStagingHook) {
    throw new Error('AgentCore Dockerfile requires .tool-dist, but the bot has no tool-staging hook');
  }
  const hookPath = path.resolve(buildRoot, toolStagingHook);
  if (!fs.existsSync(hookPath)) {
    throw new Error(`bot tool-staging hook is missing: ${hookPath}`);
  }

  run(hookPath, [], { cwd: buildRoot, stdio: 'inherit' });
  for (const runtime of spec.runtimes ?? []) {
    const dockerfilePath = runtimeDockerfilePath(projectRoot, runtime);
    if (runtime.build === 'Container' && stagedDockerfile(runtime) && !fs.existsSync(dockerfilePath)) {
      throw new Error(`The tool-staging hook did not write the runtime Dockerfile ${dockerfilePath}`);
    }
  }

  return true;
}

export function sessionApiCode(codeLocation: string, buildArgs: Record<string, string>) {
  return DockerImageCode.fromImageAsset(codeLocation, {
    file: 'session-api.Dockerfile',
    buildArgs,
    ignoreMode: IgnoreMode.DOCKER,
    exclude: [
      '**',
      '!session-api.Dockerfile',
      '!pyproject.toml',
      '!uv.lock',
      '!src/',
      '!src/**',
      '!.tool-dist/',
      '.tool-dist/*',
      '**/__pycache__',
      '**/*.pyc',
    ],
    platform: Platform.LINUX_ARM64,
  });
}
