import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { botDirectoryErrors, checkBotDirectory } from './read.cjs';

const BOTCUBE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const REPOSITORY = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: BOTCUBE_ROOT, encoding: 'utf8' }).trim();

/** A bot directory holding the files given, by their paths relative to it. */
function botDirectory(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'botcube-bot-directory-'));
  for (const file of ['botcube.yaml', ...files]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), '{}');
  }
  return root;
}

const configurationFile = (root: string, file: string) =>
  `Bot directory ${root}: ${file}: a configuration file; a deployment is botcube.yaml plus the images it names, so move its values into botcube.yaml, or into bot.yaml in the Bot Image, then delete the file`;

describe('a bot directory', () => {
  it.each(['settings.json', 'release.json', '.env', 'deploy/ecs/config.yaml', 'deploy/overrides.toml'])(
    'fails while it holds %s, and passes once it is gone',
    file => {
      const root = botDirectory([file]);
      expect(botDirectoryErrors(root)).toEqual([configurationFile(root, file)]);
      expect(() => checkBotDirectory(root)).toThrow(configurationFile(root, file));
      rmSync(join(root, file));
      expect(botDirectoryErrors(root)).toEqual([]);
    },
  );

  it("holds its bot settings, latency budgets, build manifests and images' build contexts", () => {
    const root = botDirectory([
      'bot.yaml', 'latency-budgets.json', 'pyproject.toml', 'uv.lock',
      'deploy/stage-tools.sh', 'deploy/ecs/cdk/package.json', 'deploy/ecs/cdk/tsconfig.build.json', 'deploy/ecs/cdk/cdk.json',
      'deploy/credential-service/Dockerfile', 'deploy/credential-service/remint/settings.json',
      'deploy/link-extension/manifest.json', 'deploy/link-extension/rules.json',
      'deploy/ecs/cdk/node_modules/some-package/config.json', 'deploy/agentcore/.cli/state.json',
    ]);
    expect(botDirectoryErrors(root)).toEqual([]);
  });

  it("looks only beside botcube.yaml and in the deploy root: the bot's other directories are its source", () => {
    expect(botDirectoryErrors(botDirectory(['ui/web/tsconfig.json', 'tests/fixtures/profile.json']))).toEqual([]);
  });
});

describe("this repository's bot directories", () => {
  const configs = execFileSync('git', ['ls-files', '*botcube.yaml'], { cwd: REPOSITORY, encoding: 'utf8' }).trim().split('\n');

  it('are found', () => {
    expect(configs).toEqual(expect.arrayContaining([
      relative(REPOSITORY, join(BOTCUBE_ROOT, 'examples/enterprise/botcube.yaml')),
      relative(REPOSITORY, join(BOTCUBE_ROOT, 'examples/public/botcube.yaml')),
    ]));
  });

  it.each(configs)('hold one config beside %s: it and the images it names', config => {
    expect(botDirectoryErrors(join(REPOSITORY, dirname(config)))).toEqual([]);
  });
});
