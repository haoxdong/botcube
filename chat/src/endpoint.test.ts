import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { FakeOpenAICompatible } from '../test/fakes/fake-backends.js';
import { FakeMtlsFront, IMPOSTOR_IDENTITY, mtlsCertificates, SERVER_IDENTITY, trustCa } from '../test/fakes/mtls.js';
import { endpoint } from './endpoint.js';

const certificates = mtlsCertificates();
const keyFile = join(certificates.dir, 'models-api-key');
const models = new FakeOpenAICompatible('sk-mounted');
let front: FakeMtlsFront;
let url: string;
let untrust: () => void;
beforeAll(async () => {
  untrust = trustCa(certificates.authority);
  writeFileSync(keyFile, 'sk-mounted\n');
  await models.listen();
  front = new FakeMtlsFront(certificates, Number(new URL(models.url).port));
  url = `https://127.0.0.1:${await front.listen()}/v1`;
});
afterAll(async () => {
  await Promise.all([front.close(), models.close()]);
  untrust();
  certificates.remove();
});

it('refuses an Endpoint with TLS carrying another identity before sending it the bearer, naming the expected and received identities', async () => {
  const client = endpoint('models', { url, credential: { kind: 'file', path: keyFile }, tls: { clientCertificate: certificates.files.clientA, serverIdentity: IMPOSTOR_IDENTITY } }, {});

  const failure = client.fetch('/chat/completions', { method: 'POST', body: '{}' });

  await expect(failure).rejects.toMatchObject({ cause: { message: `models TLS: expected server identity ${IMPOSTOR_IDENTITY}, but the server presented ${SERVER_IDENTITY}` } });
  expect(models.requests).toEqual([]);
});

it('refuses an http Endpoint with TLS when it is built, before any bearer could go out in clear', () => {
  const build = () => endpoint('models', { url: 'http://127.0.0.1:8080/v1', credential: { kind: 'file', path: keyFile }, tls: { serverIdentity: SERVER_IDENTITY } }, {});

  expect(build).toThrow('models TLS: the Endpoint http://127.0.0.1:8080/v1 is not https');
});
