import type { CancellationReason, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

export type TransactionWrite = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
export type FailedWrites<Name extends string> = Pick<ReadonlyMap<Name, CancellationReason>, 'get' | 'has'>;

export function namedTransaction<const Name extends string>(writes: ReadonlyArray<readonly [Name, TransactionWrite]>) {
  return {
    command: new TransactWriteCommand({ TransactItems: writes.map(([, write]) => write) }),
    conditions(error: unknown) {
      const reasons = (error as Partial<TransactionCanceledException>).CancellationReasons;
      const failed = new Map<Name, CancellationReason>();
      const passed = new Set<Name>();
      for (const [index, [name]] of writes.entries()) {
        const reason = reasons?.[index];
        if (reason?.Code === 'ConditionalCheckFailed') failed.set(name, reason);
        if (reason?.Code === 'None') passed.add(name);
      }
      return { failed, passed };
    },
  };
}
