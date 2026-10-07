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

function runCommand(command: string, args: string[], options: CommandOptions): void {
  execFileSync(command, args, options);
}

function resolveRuntimeSourceDir(projectRoot: string, runtime: RuntimeSourceSpec): string {
  if (!runtime.codeLocation) {
    throw new Error('AgentCore Container runtime is missing codeLocation; cannot inspect Dockerfile prerequisites');
  }
  return path.isAbsolute(runtime.codeLocation) ? runtime.codeLocation : path.resolve(projectRoot, runtime.codeLocation);
}

function runtimeDockerfilePath(projectRoot: string, runtime: RuntimeSourceSpec): string {
  const sourceDir = resolveRuntimeSourceDir(projectRoot, runtime);
  const dockerfile = runtime.dockerfile ?? 'Dockerfile';
  return path.isAbsolute(dockerfile) ? dockerfile : path.join(sourceDir, dockerfile);
}

function dockerfileRequiresToolDist(dockerfilePath: string): boolean {
  if (!fs.existsSync(dockerfilePath)) {
    throw new Error(`AgentCore Container runtime Dockerfile not found at ${dockerfilePath}`);
  }

  return fs.readFileSync(dockerfilePath, 'utf8').includes('.tool-dist');
}

function requiresToolStaging(spec: AgentCoreDockerPrerequisiteSpec, projectRoot: string): boolean {
  for (const runtime of spec.runtimes ?? []) {
    if (runtime.build !== 'Container') {
      continue;
    }

    const dockerfilePath = runtimeDockerfilePath(projectRoot, runtime);
    if (dockerfileRequiresToolDist(dockerfilePath)) {
      return true;
    }
  }

  return false;
}

export function stageAgentCoreDockerPrerequisites(
  spec: AgentCoreDockerPrerequisiteSpec,
  projectRoot: string,
  run: CommandRunner = runCommand,
  buildRoot: string = projectRoot,
  toolStagingHook?: string
): boolean {
  if (!requiresToolStaging(spec, projectRoot)) {
    return false;
  }

  if (!toolStagingHook) {
    throw new Error('AgentCore Dockerfile requires .tool-dist, but the Cartridge has no tool-staging hook');
  }
  const hookPath = path.isAbsolute(toolStagingHook) ? toolStagingHook : path.resolve(buildRoot, toolStagingHook);
  if (!fs.existsSync(hookPath)) {
    throw new Error(`Cartridge tool-staging hook is missing: ${hookPath}`);
  }

  run(hookPath, [], { cwd: buildRoot, stdio: 'inherit' });

  return true;
}
