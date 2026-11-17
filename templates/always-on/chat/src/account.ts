import { accountCookies } from 'botcube-chat/account-cookies';
import { AccountStore } from 'botcube-chat/account-store';
import { chatTable } from 'botcube-chat/config';
import { templateBot } from './bot.js';

/** The template's accounts, `template_account_id` and `template_session`, in BOTCUBE_CHAT_TABLE. */
export const templateCookies = accountCookies('template');

export const templateAccountStore = (env: NodeJS.ProcessEnv, documents?: ConstructorParameters<typeof AccountStore>[2]) =>
  // The product is the bot settings' Agent Identity name.
  new AccountStore(chatTable(env), { key: 'template', product: templateBot(env).agentIdentity.name }, documents);
