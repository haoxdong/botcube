const botSettingsModule = require('botcube-ui-web/bot-settings-module');
const path = require('node:path');
const { dcvAliases } = require('botcube-ui-web/dcv-assets');

// BotCube's full-app Storybook on the default UI plugin: `BOTCUBE_STORYBOOK_BUILD_CONFIG` names this file.
module.exports = ({ appRoot }) => ({
  stories: [
    path.relative(
      path.join(appRoot, '.storybook'),
      path.join(__dirname, 'storybook/**/*.stories.tsx')
    ),
  ],
  previewAnnotations: [path.join(__dirname, 'storybook/preview.ts')],
  aliases: {
    '@bot-ui': path.join(__dirname, 'src/plugin/default.tsx'),
    '@bot-settings': botSettingsModule(path.join(__dirname, '../../examples/bot/bot.yaml')),
    'botcube-ui-web/storybook-page': path.join(appRoot, 'src/app/page.tsx'),
    ...dcvAliases,
  },
});
