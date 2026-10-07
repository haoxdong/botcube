const path = require('node:path');

// The template's full-app Storybook: `CARTRIDGE_STORYBOOK_BUILD_CONFIG` names this file.
module.exports = ({ appRoot }) => ({
  stories: [
    path.relative(
      path.join(appRoot, '.storybook'),
      path.join(__dirname, 'storybook/**/*.stories.tsx')
    ),
  ],
  previewAnnotations: [path.join(__dirname, 'storybook/preview.ts')],
  aliases: {
    '@cartridge-ui': path.join(__dirname, 'src/index.ts'),
    'botcube-ui-web/storybook-page': path.join(appRoot, 'src/app/page.tsx'),
  },
});
