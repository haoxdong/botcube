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
  'integrations.proxy.noProxy': 'proxy: integrations.proxy on each endpoint the proxy carries; every other destination goes direct',
  'integrations.modelGateway.wire': "each model's provider in /bot/bot.yaml, anthropic or openai",
  'integrations.modelGateway.cacheMarkers': "each Claude model's provider anthropic in /bot/bot.yaml, whose calls carry cache markers",
  /** A Credential Source's, wherever one sits. */
  '**.secretArn': "secretId, the secret's name or ARN",
};

/** Each key the bot settings no longer take, and what replaced it. */
export const renamedBotKeys: Readonly<Record<string, string>> = {
  userTokenInShell: 'environment, where a CLI reaches its Relay provider at ${BOTCUBE_RELAY_URL}/<provider> with no credential in the shell',
};
