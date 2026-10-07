import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, IgnoreMode, Stack } from 'aws-cdk-lib';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { cartridgeDeployRoot } from '../lib/cartridge';
import { repositoryImageProps } from '../lib/repository-image';

const repositoryRoot = path.resolve(__dirname, '../../../../..');
// The active Cartridge's folder, relative to the repository root.
const bot = path.relative(repositoryRoot, path.dirname(cartridgeDeployRoot()));

function fixture(dockerfile: string, sources: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-image-'));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write(dockerfile, fs.readFileSync(path.join(repositoryRoot, dockerfile), 'utf8'));
  for (const file of sources) write(file, file);
  return { root, write };
}

function assetHash(root: string, dockerfile: string) {
  const stack = new Stack(new App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'repository-image-out-')) }), 'Image');
  return new DockerImageAsset(stack, 'Image', { directory: root, ...repositoryImageProps(root, dockerfile) }).assetHash;
}

const images = {
  credential: {
    dockerfile: `${bot}/deploy/credential-service/Dockerfile`,
    sources: [`${bot}/pyproject.toml`, `${bot}/uv.lock`, `${bot}/README.md`, `${bot}/src/package/__init__.py`,
      `${bot}/deploy/credential-service/remint/package.json`, `${bot}/deploy/credential-service/remint/package-lock.json`,
      'tests/ci/resume-auth.mjs', 'tests/ci/resume-auth-lib.mjs',
      'botcube/credential-service/pyproject.toml', 'botcube/credential-service/src/package/server.py'],
    followed: [`${bot}/src/package/__init__.py`, `${bot}/uv.lock`, 'tests/ci/resume-auth.mjs',
      'botcube/credential-service/src/package/server.py'],
    ignored: ['docs/runbooks/preview-origin.md', `${bot}/tests/test_preview.py`, `${bot}/chat/src/main.ts`,
      'botcube/credential-service/tests/test_server.py'],
  },
  chat: {
    dockerfile: `${bot}/chat/Dockerfile`,
    sources: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches/bedrock-agentcore@0.4.5.patch',
      'botcube/chat/package.json', 'botcube/chat/src/server.ts', 'botcube/chat/src/server.test.ts',
      `${bot}/chat/package.json`, `${bot}/chat/src/main.ts`],
    followed: ['pnpm-lock.yaml', 'botcube/chat/src/server.ts', `${bot}/chat/src/main.ts`],
    ignored: ['docs/runbooks/preview-origin.md', `${bot}/src/package/__init__.py`, `${bot}/chat/dist/main.js`,
      'botcube/chat/src/server.test.ts', 'tests/chat/threads.test.ts'],
  },
};

test('an image builds for linux/amd64 from its Dockerfile and its own COPY sources, never build-stage paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-image-'));
  fs.writeFileSync(path.join(root, 'Dockerfile'), [
    'FROM node AS build', 'COPY package.json pnpm-lock.yaml ./', 'COPY --from=build /app/dist ./dist', 'COPY src/ ./src/',
    '# COPY docs/ ./docs/', 'COPY  README.md  ./', 'RUN pnpm build',
  ].join('\n'));
  expect(repositoryImageProps(root, 'Dockerfile')).toEqual({
    file: 'Dockerfile', platform: Platform.LINUX_AMD64, ignoreMode: IgnoreMode.DOCKER,
    exclude: ['*', '!Dockerfile', '!package.json', '!pnpm-lock.yaml', '!src', '!README.md', '**/*.test.ts'],
  });
});

test('a COPY line ending in whitespace or a carriage return ships only its sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-image-'));
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM node\r\nCOPY package.json ./ \t\nCOPY src/ ./src/\r\n');
  expect(repositoryImageProps(root, 'Dockerfile').exclude).toEqual(['*', '!Dockerfile', '!package.json', '!src', '**/*.test.ts']);
});

describe.each(Object.entries(images))('%s image', (_name, { dockerfile, sources, followed, ignored }) => {
  test('hash ignores files the image does not ship', () => {
    const { root, write } = fixture(dockerfile, sources);
    const before = assetHash(root, dockerfile);
    for (const file of ignored) write(file, 'changed');
    expect(assetHash(root, dockerfile)).toBe(before);
  });

  test.each([...followed, dockerfile])('hash follows %s', file => {
    const { root, write } = fixture(dockerfile, sources);
    const before = assetHash(root, dockerfile);
    write(file, `${fs.readFileSync(path.join(root, file), 'utf8')}\n# changed`);
    expect(assetHash(root, dockerfile)).not.toBe(before);
  });
});
