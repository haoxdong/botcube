import type { BotSettings } from 'botcube-deployment-config';
import { loadDeployment, parseBotSettings } from 'botcube-deployment-config/load';
import exampleBot from '../../../../examples/bot/bot.json' with { type: 'json' };

/** The bot settings the template serves: its Deployment Config's when one is named, else the example bot's. */
export function templateBot(env: NodeJS.ProcessEnv): BotSettings {
  return env.BOTCUBE_DEPLOYMENT_CONFIG ? loadDeployment(env.BOTCUBE_DEPLOYMENT_CONFIG).bot : parseBotSettings(exampleBot, 'examples/bot/bot.json');
}
