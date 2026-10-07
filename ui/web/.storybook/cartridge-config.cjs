const path = require('node:path');

exports.loadCartridgeConfig = ({ appRoot, repoRoot }) => {
  const config = process.env.CARTRIDGE_STORYBOOK_BUILD_CONFIG;
  return config
    ? require(path.resolve(repoRoot, config))({ appRoot, repoRoot })
    : {};
};
