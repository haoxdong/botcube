import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, IgnoreMode, Stack } from 'aws-cdk-lib';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { repositoryImageProps } from '../lib/repository-image';

function assetHash(root: string, dockerfile: string) {
  const stack = new Stack(new App({ outdir: fs.mkdtempSync(path.join(os.tmpdir(), 'repository-image-out-')) }), 'Image');
  return new DockerImageAsset(stack, 'Image', { directory: root, ...repositoryImageProps(root, dockerfile) }).assetHash;
}

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

test('a neutral Dockerfile asset follows only its own shipped sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neutral-image-'));
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM scratch\nCOPY app.txt /app.txt\n');
  fs.writeFileSync(path.join(root, 'app.txt'), 'first');
  const before = assetHash(root, 'Dockerfile');
  fs.writeFileSync(path.join(root, 'private.txt'), 'ignored');
  expect(assetHash(root, 'Dockerfile')).toBe(before);
  fs.writeFileSync(path.join(root, 'app.txt'), 'second');
  expect(assetHash(root, 'Dockerfile')).not.toBe(before);
});

test.each(['botcube', '.'])('Cartridge image includes BotCube sources from %s repository layout', (cubeRoot) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartridge-image-'));
  const source = path.join(root, cubeRoot, 'template');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM scratch\nARG BOTCUBE_ROOT=botcube\nCOPY ${BOTCUBE_ROOT}/template/ /app/\n');
  fs.writeFileSync(path.join(source, 'app.txt'), 'first');
  const before = assetHash(root, 'Dockerfile');
  fs.writeFileSync(path.join(source, 'app.txt'), 'second');
  expect(assetHash(root, 'Dockerfile')).not.toBe(before);
  expect(repositoryImageProps(root, 'Dockerfile').buildArgs).toEqual({ BOTCUBE_ROOT: cubeRoot });
});
