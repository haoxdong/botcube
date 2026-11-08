import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { expect, it } from 'vitest';
import {
  DynamoDBSessionMetadata,
  SessionDeletedError,
  type TurnAdmission,
} from '../../src/session-metadata.js';
import { createChatTable } from './stack.js';
import { motoAws, motoEndpoint } from '../fakes/moto.js';


const OWNER = 'account-2043';
const TURN: TurnAdmission = { filingUserId: 'filing-2043', title: 'hello', allocation: true };

function client(): DynamoDBClient {
  return new DynamoDBClient(motoAws());
}

it('refuses a Turn that lands after account-history deletion reads the account\'s Sessions', async () => {
  const table = `chat-${Math.random().toString(36).slice(2)}`;
  await createChatTable(motoEndpoint(), table);
  const otherTab = new DynamoDBSessionMetadata(table, client());
  const deletingClient = client();
  const deleting = new DynamoDBSessionMetadata(table, deletingClient);
  await otherTab.recordTurn(OWNER, 'session-1', TURN);

  let lateTurn: Promise<unknown> | undefined;
  deletingClient.middlewareStack.add(
    (next, context) => async (args) => {
      const result = await next(args);
      const readsSessions = context.commandName === 'QueryCommand' && JSON.stringify(args.input).includes('SESSION#');
      if (readsSessions && lateTurn === undefined) {
        lateTurn = otherTab.recordTurn(OWNER, 'late-session', TURN).catch((error: unknown) => error);
        await lateTurn;
      }
      return result;
    },
    { step: 'initialize' },
  );

  const fenced = await deleting.fenceOwner(OWNER);

  expect(await lateTurn).toBeInstanceOf(SessionDeletedError);
  expect(fenced.map((session) => session.session_id)).toEqual(['session-1']);
  expect(await otherTab.list(OWNER)).toEqual([]);
});
