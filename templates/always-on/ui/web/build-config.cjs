const path = require('node:path');
const { liveViewEntry, dcvAliases, materializeDcvAssets } = require('botcube-ui-web/dcv-assets');

module.exports = function templateWebBuildConfig({ appRoot }) {
  materializeDcvAssets(appRoot);
  return {
    cartridgeUiEntry: require.resolve('./src/index.ts'),
    botSettings: path.join(__dirname, '../../../../examples/bot/bot.json'),
    transpilePackages: ['bedrock-agentcore'],
    turbopackAliases: dcvAliases,
    webpackAliases: {
      'bedrock-agentcore/browser/live-view': liveViewEntry,
      ...dcvAliases,
    },
  };
};
