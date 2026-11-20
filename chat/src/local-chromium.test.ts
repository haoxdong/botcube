import { expect, it } from 'vitest';
import { chromiumProxyArgs } from './local-chromium.js';
import { localAgentComputer } from './local-agent-computer.js';

const proxied = (noProxy: string) => ({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://proxy.example:3128', NO_PROXY: noProxy });

it('starts Chromium direct without the Deployment Config proxy', () => {
  expect(chromiumProxyArgs({})).toEqual([]);
  expect(chromiumProxyArgs({ HTTPS_PROXY: 'http://proxy.example:3128' })).toEqual([]);
});

it('starts Chromium through the proxy, bypassing what NO_PROXY reaches directly', () => {
  expect(chromiumProxyArgs(proxied('localhost,127.0.0.1,::1,169.254.169.254,.example.net,example.com'))).toEqual([
    '--proxy-server=http://proxy.example:3128',
    '--proxy-bypass-list=localhost;*.localhost;127.0.0.1;[::1];169.254.169.254;example.net;*.example.net;example.com;*.example.com',
  ]);
});

it('keeps ports, CIDR blocks and bracketed IPv6 in the form Chromium reads', () => {
  expect(chromiumProxyArgs(proxied('internal.test:8443,192.0.2.0/24,2001:db8::/32,[fe80::1]:99,*.wild.test'))).toEqual([
    '--proxy-server=http://proxy.example:3128',
    '--proxy-bypass-list=internal.test:8443;*.internal.test:8443;192.0.2.0/24;2001:db8::/32;[fe80::1]:99;wild.test;*.wild.test',
  ]);
});

it('trims NO_PROXY entries and drops empty ones, as a value with spaces or a trailing comma writes them', () => {
  expect(chromiumProxyArgs(proxied(' localhost , example.com,, '))).toEqual([
    '--proxy-server=http://proxy.example:3128',
    '--proxy-bypass-list=localhost;*.localhost;example.com;*.example.com',
  ]);
  expect(chromiumProxyArgs(proxied('example.com,'))).toEqual([
    '--proxy-server=http://proxy.example:3128',
    '--proxy-bypass-list=example.com;*.example.com',
  ]);
  expect(chromiumProxyArgs(proxied(' * '))).toEqual(['--no-proxy-server']);
});

it('bypasses nothing when NO_PROXY is empty', () => {
  expect(chromiumProxyArgs(proxied(''))).toEqual(['--proxy-server=http://proxy.example:3128']);
  expect(chromiumProxyArgs(proxied(' , '))).toEqual(['--proxy-server=http://proxy.example:3128']);
});

it('goes direct everywhere when NO_PROXY is *', () => {
  expect(chromiumProxyArgs(proxied('localhost,*'))).toEqual(['--no-proxy-server']);
});

it.each(['http://user:secret@proxy.example:3128', 'http://user@proxy.example:3128'])('refuses a proxy URL with credentials, which Chromium would drop: %s', (url) => {
  const env = { NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: url, NO_PROXY: 'localhost' };
  const refusal = /Chromium can't authenticate to a proxy: remove the credentials from the Deployment Config's proxy URL/;
  expect(() => chromiumProxyArgs(env)).toThrow(refusal);
  expect(() => localAgentComputer({ history: { owns: async () => true, ownsMainChat: async () => false }, requester: async () => ({ owner: 'acct_1' }), env })).toThrow(refusal);
});
