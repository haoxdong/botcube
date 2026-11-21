const path = require('node:path');

exports.loadBotConfig = ({ appRoot, repoRoot }) => {
  const config = process.env.BOTCUBE_STORYBOOK_BUILD_CONFIG;
  // Unset, Storybook would build the Cube with no stories and still succeed.
  if (!config) {
    throw new Error(
      'BOTCUBE_STORYBOOK_BUILD_CONFIG is unset: run Storybook through the root or botcube package scripts, which name a bot storybook-config.cjs'
    );
  }
  return require(path.resolve(repoRoot, config))({ appRoot, repoRoot });
};
