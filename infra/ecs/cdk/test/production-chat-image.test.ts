// The preview origin's Chat Service and Credential Service images: the one the BotCube Config names, else a build of
// the Dockerfile the bot's own ECS app names, else the stock image.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { productionChatImage, productionCredentialImage, serviceImages } from '../lib/service-images.js';
import { repositoryImageProps } from '../lib/repository-image.js';

const botcubeRoot = path.resolve(__dirname, '../../../..');
const DIGEST = `@sha256:${'c'.repeat(64)}`;

test("a bot's own chat Dockerfile, which its ECS app names, builds on the BotCube Config beside its deploy root and names no image path", () => {
  expect(productionChatImage('/repo', '/repo/product/deploy', 'product/chat/Dockerfile')).toEqual({
    file: 'product/chat/Dockerfile', config: '/repo/product/botcube.yaml',
  });
});

test('an image the BotCube Config names runs on the BotCube Config beside its deploy root, not the public example', () => {
  expect(productionChatImage('/repo', '/repo/product/deploy', undefined, `registry.example/chat${DIGEST}`)).toEqual({
    file: path.relative('/repo', path.join(botcubeRoot, 'chat/Dockerfile')), config: '/repo/product/botcube.yaml',
  });
});

test('a Dockerfile in the retired deploy root layout, which no ECS app names, is not built', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-layout-'));
  try {
    for (const file of ['product/chat/Dockerfile', 'product/deploy/credential-service/Dockerfile']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), 'FROM scratch\n');
    }
    expect(productionChatImage(root, path.join(root, 'product/deploy')).file).not.toContain('product/');
    expect(productionCredentialImage(root)).not.toContain('product/');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the public example, with no chat of its own, builds the stock Chat Service on its BotCube Config', () => {
  const image = productionChatImage(botcubeRoot, path.join(botcubeRoot, 'examples/public/deploy'));
  expect(image).toEqual({
    file: 'chat/Dockerfile', config: path.join(botcubeRoot, 'examples/public/botcube.yaml'),
  });
  expect(repositoryImageProps(botcubeRoot, image.file).file).toBe('chat/Dockerfile');
  expect(fs.readFileSync(path.join(botcubeRoot, image.file), 'utf8'))
    .not.toContain('botcube.yaml');
});

test("a bot's own Credential Service Dockerfile, which its ECS app names, builds", () => {
  expect(productionCredentialImage(botcubeRoot, 'product/credential-service/Dockerfile')).toBe('product/credential-service/Dockerfile');
});

test('the public example, with no Credential Service of its own, builds the stock one from its packages', () => {
  const file = productionCredentialImage(botcubeRoot);
  expect(file).toBe('credential-service/Dockerfile');
  expect(repositoryImageProps(botcubeRoot, file).exclude).toEqual(['*', '!credential-service/Dockerfile', '!credential-source', '!credential-service', '**/*.test.ts']);
});

/** The task's container image and execution role grants, and the audit-copy function's image, the images give. */
function deployed(images: ReturnType<typeof serviceImages>) {
  const stack = new Stack(new App(), 'Images', { env: { account: '000000000000', region: 'us-east-1' } });
  const chat = new ecs.FargateTaskDefinition(stack, 'Chat');
  chat.addContainer('chat', { image: images.chat });
  const credential = new ecs.FargateTaskDefinition(stack, 'Credential');
  credential.addContainer('credential', { image: images.credential.service });
  new lambda.Function(stack, 'AuditCopy', { code: images.credential.auditCopy, handler: lambda.Handler.FROM_IMAGE, runtime: lambda.Runtime.FROM_IMAGE });
  const template = Template.fromStack(stack);
  const image = (family: string) => Object.values(template.findResources('AWS::ECS::TaskDefinition'))
    .find(({ Properties }) => JSON.stringify(Properties.Family).includes(family))?.Properties.ContainerDefinitions[0].Image;
  const pulls = Object.values(template.findResources('AWS::IAM::Policy'))
    .flatMap(({ Properties }) => Properties.PolicyDocument.Statement)
    .filter(({ Action }) => [Action].flat().includes('ecr:BatchGetImage'))
    .map(({ Resource }) => Resource);
  const [auditCopy] = Object.values(template.findResources('AWS::Lambda::Function')).map(({ Properties }) => Properties.Code.ImageUri);
  return { chat: image('Chat'), credential: image('Credential'), pulls, auditCopy };
}

test('the images the BotCube Config names run in place of the builds, each pulled from its own repository', () => {
  const chat = `mirror.example.com/acme/chat${DIGEST}`;
  const credential = `123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/credentials${DIGEST}`;
  const images = serviceImages(botcubeRoot, { chatService: { image: chat }, credentialService: { image: credential } }, { chat: 'chat/Dockerfile', credential: 'credential-service/Dockerfile' });
  expect(deployed(images)).toEqual({
    chat, credential, auditCopy: credential,
    pulls: ['arn:aws:ecr:us-east-1:123456789012:repository/acme/credentials'],
  });
});

test('a Chat Service image in Amazon ECR is pulled by its task with a grant on its repository', () => {
  const chat = `123456789012.dkr.ecr.us-east-1.amazonaws.com/acme/chat:1`;
  const { pulls } = deployed(serviceImages(botcubeRoot, { chatService: { image: chat } }, { chat: 'chat/Dockerfile', credential: 'credential-service/Dockerfile' }));
  expect(pulls).toContain('arn:aws:ecr:us-east-1:123456789012:repository/acme/chat');
});
