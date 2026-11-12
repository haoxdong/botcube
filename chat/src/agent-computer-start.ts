import type { AgentComputerBrowser, AgentComputerRecords } from './agent-computer-types.js';
import type { RunningAgentComputer } from './account-resources.js';
import type { AccountFiles } from './files.js';

export async function startAgentComputer(accountId: string, threadId: string, {
  records, browser, files, seed, stop, deadline,
}: {
  records: () => AgentComputerRecords;
  browser: () => AgentComputerBrowser;
  files: () => AccountFiles;
  seed: (accountId: string, threadId: string, sessionId: string) => Promise<void>;
  stop: (record: RunningAgentComputer) => Promise<void>;
  deadline: () => number;
}): Promise<RunningAgentComputer> {
    await records().assertBrowserAllowed(accountId, threadId);
    const admission = await records().scheduledBrowserAdmission(accountId, threadId);
    const record: RunningAgentComputer = { accountId, threadId, sessionId: null, phase: 'starting', idleDeadline: deadline(),
      ...(admission === null ? {} : { scheduledExecution: admission.holder }) };
    await records().saveRunningAgentComputer(record);
    try {
      const { profileId } = await records().agentComputer(accountId);
      record.sessionId = await browser().start(profileId, await files().mount(accountId));
      await records().saveRunningAgentComputer(record);
      await seed(accountId, threadId, record.sessionId);
      record.phase = 'awake';
      record.idleDeadline = deadline();
      await records().saveRunningAgentComputer(record);
      return record;
    } catch (error) {
      record.phase = 'failed';
      const errors = [error];
      try { await records().saveRunningAgentComputer(record); }
      catch (storageError) { errors.push(storageError); }
      try { await stop(record); }
      catch (stopError) { errors.push(stopError); }
      if (errors.length > 1) throw new AggregateError(errors, error instanceof Error ? error.message : String(error));
      throw error;
    }
}
