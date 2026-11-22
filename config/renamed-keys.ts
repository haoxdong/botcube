const BOT_SETTINGS = "in /bot/bot.yaml, the Bot Image's bot settings";
const WEB_ORIGINS = 'domains.web and domains.webAliases';

/** Each key the BotCube Config no longer takes, by its dotted path, and what replaced it. */
export const renamedKeys = {
  bot: '/bot/bot.yaml in the Bot Image; remove bot',
  identity: 'integrations.signIn',
  models: 'integrations.modelGateway',
  turnCredentials: 'integrations.awsAccess',
  awsAccess: 'integrations.awsAccess',
  harnessAuth: 'integrations.harnessAuth',
  telemetry: 'integrations.telemetry',
  imageRegistry: 'integrations.imageRegistry',
  supplied: 'existing',
  proxy: 'integrations.proxy',
  corsOrigins: WEB_ORIGINS,
  web: WEB_ORIGINS,
  productName: `productName ${BOT_SETTINGS}`,
  productService: `productService ${BOT_SETTINGS}`,
  'network.proxy': 'integrations.proxy',
  'network.corsOrigins': WEB_ORIGINS,
  'existing.network': 'existing.vpc, with network.natGateways 0',
  /** A Credential Source's, wherever one sits. */
  '**.secretArn': "secretId, the secret's name or ARN",
};
