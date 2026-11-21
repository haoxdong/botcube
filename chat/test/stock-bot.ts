import { stageBotImage } from './bot-image.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { AccountStore } from '../src/account-store.js';
import type { Account } from '../src/account-record.js';
import { filingUserId } from '../src/filing-user-id.js';

/** The test bot's account key: its cookies are `test_account_id` and `test_session`. */
export const TEST_ACCOUNT_KEY = 'test';

/** The test bot's settings, as a bot's own `bot.yaml` names them. */
const TEST_BOT = {
  agentIdentity: { name: 'Test Bot', character: 'A test agent', avatar: '' },
  accountKey: TEST_ACCOUNT_KEY,
  soul: 'Be brief.',
  models: [
    { key: 'quick', label: 'Quick', provider: 'anthropic' },
    { key: 'thorough', label: 'Thorough', description: 'Slower, more careful', provider: 'anthropic' },
  ],
};

/** A BotCube Config naming the test bot's settings (or `bot`), in a fresh directory. */
export function testBotCubeConfig(bot: Record<string, unknown> = TEST_BOT, sections: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'chat-test-deployment-'));
  stageBotImage(bot);
  writeFileSync(join(dir, 'bot.yaml'), JSON.stringify(bot));
  writeFileSync(join(dir, 'botcube.yaml'), JSON.stringify({ ...sections }));
  return join(dir, 'botcube.yaml');
}

/** The user ID the test bot files an account's Sessions under. */
export const filed = (owner: string) => filingUserId(TEST_ACCOUNT_KEY, owner);

/** The test bot's accounts, where a test signs an account in under an ID it chooses. */
export class TestAccounts extends AccountStore {
  private readonly sessions = new Map<string, Promise<string>>();

  constructor(table: string, documents?: Pick<DynamoDBDocumentClient, 'send'>) {
    super(table, { key: TEST_ACCOUNT_KEY, product: TEST_BOT.agentIdentity.name }, documents);
  }

  /** A live session token for `accountId`, registering the account on first use; a test's fake clock can expire one. */
  async signIn(accountId: string): Promise<string> {
    const cached = this.sessions.get(accountId);
    if (cached !== undefined && await this.liveSession(await cached) !== null) return cached;
    const session = (cached ?? this.register(accountId)).then(() => this.createSession(accountId));
    this.sessions.set(accountId, session);
    return session;
  }

  private register(accountId: string): Promise<void> {
    return this.mutation(async (lease) => {
      if (await this.loadAccount(accountId) !== null) return;
      const now = Math.floor(Date.now() / 1000);
      const account: Account = { version: 1, accountId, status: 'registered', rateTier: 'authenticated', createdAt: now, updatedAt: now };
      const operation = this.put(this.accountItem(this.newAccount(account)));
      operation.Put.ConditionExpression = 'attribute_not_exists(pk)';
      await this.commit(lease, [operation]);
    });
  }
}
