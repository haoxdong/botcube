import { paginateListSchedules, SchedulerClient } from '@aws-sdk/client-scheduler';
import { motoAws } from './fakes/moto.js';
import { SchedulerView, type Schedule, type ScheduledRuns } from './fakes/scheduler.js';

/** Resolve a task by the public ID Scheduler actually delivers. */
export class TaskSchedules extends SchedulerView {
  private readonly client = new SchedulerClient(motoAws());

  constructor(endpoint: string, runs: ScheduledRuns) {
    super(endpoint, runs);
  }

  override async schedule(taskId: string): Promise<Schedule | null> {
    const direct = await super.schedule(taskId);
    if (direct !== null) return direct;
    const pages = paginateListSchedules({ client: this.client }, { GroupName: this.runs.group });
    for await (const page of pages) {
      const schedules = await Promise.all((page.Schedules ?? []).flatMap(({ Name }) => Name ? [super.schedule(Name)] : []));
      const match = schedules.find((schedule) => schedule !== null && (JSON.parse(schedule.Target.Input) as { taskId: string }).taskId === taskId);
      if (match !== undefined) return match;
    }
    return null;
  }

  override async fire(taskId: string): Promise<void> {
    // SchedulerView.fire uses the physical name for both the lookup and one-off deletion.
    await super.fire(await this.name(taskId));
  }

  async name(taskId: string): Promise<string> {
    const schedule = await this.schedule(taskId);
    if (schedule === null) throw new Error(`No schedule for task ${taskId}`);
    return schedule.Name;
  }
}
