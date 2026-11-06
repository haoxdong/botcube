const { liveViewEntry, dcvAliases, materializeDcvAssets } = require('botcube-ui-web/dcv-assets');

module.exports = function templateWebBuildConfig({ appRoot }) {
  materializeDcvAssets(appRoot);
  return {
    cartridgeUiEntry: require.resolve('./src/index.ts'),
    transpilePackages: ['bedrock-agentcore'],
    turbopackAliases: dcvAliases,
    webpackAliases: {
      'bedrock-agentcore/browser/live-view': liveViewEntry,
      ...dcvAliases,
    },
  };
};
