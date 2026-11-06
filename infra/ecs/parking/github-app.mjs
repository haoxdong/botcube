import { sign } from 'node:crypto';

/**
 * A repository-scoped installation token for a GitHub App, narrowed to `permissions`.
 * @param {{ app_id: string | number, private_key: string }} app
 * @param {string} repository owner/name
 * @param {Record<string, 'read' | 'write'>} permissions
 */
export async function installationToken(app, repository, permissions, fetch = globalThis.fetch) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (/** @type {object} */ value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iat: now - 60, exp: now + 540, iss: app.app_id });
  const jwt = payload + '.' + sign('RSA-SHA256', Buffer.from(payload), app.private_key).toString('base64url');
  const headers = { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const installation = await fetch(`https://api.github.com/repos/${repository}/installation`, { headers });
  if (!installation.ok) throw new Error(`GitHub App installation lookup for ${repository} failed with HTTP ${installation.status}`);
  const { id } = await installation.json();
  const minted = await fetch(`https://api.github.com/app/installations/${id}/access_tokens`, {
    method: 'POST', headers, body: JSON.stringify({ repositories: [repository.split('/')[1]], permissions }),
  });
  if (!minted.ok) throw new Error(`GitHub App token mint failed with HTTP ${minted.status}: ${await minted.text()}`);
  const { token } = await minted.json();
  if (!token) throw new Error('GitHub returned no installation token');
  return /** @type {string} */ (token);
}
