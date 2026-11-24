const { createHash } = require('node:crypto');

function configBucketName(account, region, stackName) {
  const stack = createHash('sha256').update(stackName).digest('hex').slice(0, 16);
  return `botcube-config-${account}-${region}-${stack}`;
}

module.exports = { configBucketName };
