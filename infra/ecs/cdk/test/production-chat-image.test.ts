// The preview origin's Chat Service image: a deploy root beside its own `chat/` builds that one; any other runs the
// stock Chat Service, which needs a Deployment Config its image ships.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { productionChatImage } from '../lib/production-app.js';
import { repositoryImageProps } from '../lib/repository-image.js';

const botcubeRoot = path.resolve(__dirname, '../../../..');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test('a deploy root with its own chat Dockerfile builds it and names no Deployment Config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'own-chat-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'product/deploy'), { recursive: true });
  fs.mkdirSync(path.join(root, 'product/chat'));
  fs.writeFileSync(path.join(root, 'product/chat/Dockerfile'), 'FROM scratch\n');
  expect(productionChatImage(root, path.join(root, 'product/deploy'))).toEqual({ file: 'product/chat/Dockerfile' });
});

test('the public example, with no chat of its own, builds the stock Chat Service on its Deployment Config', () => {
  const image = productionChatImage(botcubeRoot, path.join(botcubeRoot, 'examples/public/deploy'));
  expect(image).toEqual({ file: 'chat/Dockerfile', deploymentConfig: '/opt/chat-service/examples/public/deployment-config.json' });
  expect(repositoryImageProps(botcubeRoot, image.file).file).toBe('chat/Dockerfile');
  expect(fs.readFileSync(path.join(botcubeRoot, image.file), 'utf8'))
    .toContain('COPY ${BOTCUBE_ROOT}/examples/public/deployment-config.json examples/public/deployment-config.json');
});
