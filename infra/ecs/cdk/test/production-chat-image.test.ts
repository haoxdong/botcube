// The preview origin's Chat Service and Credential Service images: a deploy root with its own builds that one; any
// other runs the stock image (the Chat Service on a Deployment Config its image ships).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { productionChatImage, productionCredentialImage } from '../lib/production-app.js';
import { repositoryImageProps } from '../lib/repository-image.js';

const botcubeRoot = path.resolve(__dirname, '../../../..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('a deploy root with its own chat Dockerfile builds it on the BotCube Config beside it and names no image path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-chat-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'product/deploy'), { recursive: true });
  fs.mkdirSync(path.join(root, 'product/chat'));
  fs.writeFileSync(path.join(root, 'product/chat/Dockerfile'), 'FROM scratch\n');
  expect(productionChatImage(root, path.join(root, 'product/deploy'))).toEqual({
    file: 'product/chat/Dockerfile', config: path.join(root, 'product/deployment-config.json'),
  });
});

test('the public example, with no chat of its own, builds the stock Chat Service on its Deployment Config', () => {
  const image = productionChatImage(botcubeRoot, path.join(botcubeRoot, 'examples/public/deploy'));
  expect(image).toEqual({
    file: 'chat/Dockerfile', config: path.join(botcubeRoot, 'examples/public/deployment-config.json'),
    deploymentConfig: '/opt/chat-service/examples/public/deployment-config.json',
  });
  expect(repositoryImageProps(botcubeRoot, image.file).file).toBe('chat/Dockerfile');
  expect(fs.readFileSync(path.join(botcubeRoot, image.file), 'utf8'))
    .toContain('COPY ${BOTCUBE_ROOT}/examples/public/deployment-config.json examples/public/deployment-config.json');
});

test('a deploy root with its own Credential Service Dockerfile builds it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-credential-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'product/deploy/credential-service'), { recursive: true });
  fs.writeFileSync(path.join(root, 'product/deploy/credential-service/Dockerfile'), 'FROM scratch\n');
  expect(productionCredentialImage(root, path.join(root, 'product/deploy'))).toBe('product/deploy/credential-service/Dockerfile');
});

test('the public example, with no Credential Service of its own, builds the stock one from the package and the example BotCube Configs it copies', () => {
  const file = productionCredentialImage(botcubeRoot, path.join(botcubeRoot, 'examples/public/deploy'));
  expect(file).toBe('credential-service/Dockerfile');
  expect(repositoryImageProps(botcubeRoot, file).exclude).toEqual(['*', '!credential-service/Dockerfile', '!credential-service', '!examples/enterprise/deployment-config.json', '!examples/public/deployment-config.json', '**/*.test.ts']);
});
