declare module '@bot-ui' {
  export const webUiPlugin: import('./types.js').WebUiPlugin;
}

/** The bot settings file this page is built with: the build config's `botSettings`, else the example bot's. */
declare module '@bot-settings' {
  const settings: unknown;
  export default settings;
}
