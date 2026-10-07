import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { presignAwsUrl, signedAwsHeaders } from './aws.js';

// The expected signatures are botocore's (SigV4Auth and SigV4QueryAuth) for the same request,
// credentials and time.
beforeEach(() => {
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIDEXAMPLE');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const RUNTIME_URL =
  'https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-west-2%3A123456789012%3Aruntime%2Fagent-1/invocations?qualifier=DEFAULT';

describe('SigV4 headers', () => {
  it('signs every repeated query value as botocore does', async () => {
    const headers = await signedAwsHeaders('bedrock-agentcore', 'us-west-2', {
      method: 'POST',
      url: 'https://wrapper.example/turn?version=2&version=1',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260927/us-west-2/bedrock-agentcore/aws4_request, ' +
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
      'Signature=efc51a57f9ec7cd5e8c7ff9c05f75c4dbfd442ebfb560700f3764a4eec77c357',
    );
  });
  it('sign the method, path, query, headers and body as botocore does, leaving host to the HTTP client', async () => {
    const headers = await signedAwsHeaders('bedrock-agentcore', 'us-west-2', {
      method: 'POST',
      url: RUNTIME_URL,
      headers: { 'content-type': 'application/json', 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': 'session-1' },
      body: '{"prompt":"hi"}',
    });

    expect(headers).toEqual({
      'content-type': 'application/json',
      'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id': 'session-1',
      'x-amz-content-sha256': '14479f4e87d340fe0ca0d522d87a5b3a028ebb1af24fbb8d3ef4553044fc6db6',
      'x-amz-date': '20260927T120000Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260927/us-west-2/bedrock-agentcore/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amzn-bedrock-agentcore-runtime-session-id, ' +
        'Signature=0cda2148420b47396aa3969f10a8261944871caa83da740321d2d4a811da46ab',
    });
  });
});

describe('a SigV4 presigned URL', () => {
  it('carries the signature in its query, as botocore presigns it', async () => {
    const url = await presignAwsUrl(
      'bedrock-agentcore',
      'us-west-2',
      'https://bedrock-agentcore.us-west-2.amazonaws.com/browser-streams/aws.browser.v1/sessions/S-1/live-view',
      300,
    );

    expect(url).toBe(
      'https://bedrock-agentcore.us-west-2.amazonaws.com/browser-streams/aws.browser.v1/sessions/S-1/live-view' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIDEXAMPLE%2F20260927%2Fus-west-2%2Fbedrock-agentcore%2Faws4_request' +
        '&X-Amz-Date=20260927T120000Z&X-Amz-Expires=300&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=446dd0ed30a7f357bbba37eb05c8193e0cccb12126833d308f4316ca1c9ddfd8',
    );
  });
});
