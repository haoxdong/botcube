const path = require('node:path');

exports.loadCartridgeConfig = ({ appRoot, repoRoot }) => {
  const config = process.env.CARTRIDGE_STORYBOOK_BUILD_CONFIG;
  // Unset, Storybook would build the Cube with no stories and still succeed.
  if (!config) {
    throw new Error(
      'CARTRIDGE_STORYBOOK_BUILD_CONFIG is unset: run Storybook through the root or botcube package scripts, which name a Cartridge storybook-config.cjs'
    );
  }
  return require(path.resolve(repoRoot, config))({ appRoot, repoRoot });
};
