const TAG = ':[A-Za-z0-9_][A-Za-z0-9._-]{0,127}';
const DIGEST = '@sha256:[0-9a-f]{64}';
/** An image reference's pin: a digest, or a tag with an optional digest. */
const PINNED = `(${DIGEST}|${TAG}(${DIGEST})?)`;
/** An Amazon ECR image URI, `<account>.dkr.ecr.<region>.amazonaws.com[.cn]/<repository>`, pinned. */
const ECR_IMAGE = new RegExp(`^\\d{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com(\\.cn)?\\/[a-z0-9._/-]+${PINNED}$`);

function ecrRepositoryArn(uri) {
  const match = ECR_IMAGE.exec(uri);
  if (!match) return undefined;
  const host = uri.slice(0, uri.indexOf('/'));
  const [account, , , region] = host.split('.');
  const [repository] = uri.slice(host.length + 1).split(/[:@]/, 1);
  return `arn:${match[1] ? 'aws-cn' : 'aws'}:ecr:${region}:${account}:repository/${repository}`;
}

module.exports = { PINNED, ECR_IMAGE, ecrRepositoryArn };
