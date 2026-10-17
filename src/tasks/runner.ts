import type { Logger } from 'pino';
import type { Db } from '../db/pool.js';
import { retryDelayMs } from '../sync/queue.js';
import { WorkLoop } from '../util/work-loop.js';
import type { TaskDeps, TaskHandler } from './handlers.js';
import { TASK_HANDLERS, TASK_PAYLOAD_SCHEMAS } from './handlers.js';
import type { ClaimedTask, TaskKind } from './queue.js';
import { claimTasks, completeTask, failTask } from './queue.js';

/** A catalog sync of a big store can take minutes; an expired lease lets another worker retry. */
export const TASK_LEASE_MS = 10 * 60_000;
/** From this many failed attempts on, failures are logged as errors (the task keeps retrying). */
const LOUD_AFTER_ATTEMPTS = 10;

export interface TaskRunnerOptions {
  db: Db;
  deps: TaskDeps;
  logger: Logger;
  concurrency: number;
  /** Poll interval when there is nothing to do. */
  idleMs?: number;
}

/** Background loop: keeps up to `concurrency` tasks running while there is work. */
export class TaskRunner {
  private readonly loop: WorkLoop<ClaimedTask>;

  constructor(opts: TaskRunnerOptions) {
    const { db, deps, logger } = opts;
    this.loop = new WorkLoop({
      name: 'task runner',
      concurrency: opts.concurrency,
      idleMs: opts.idleMs ?? 2000,
      logger,
      claim: (limit) => claimTasks(db, limit, TASK_LEASE_MS),
      run: (task) => runTask(db, deps, task, logger),
    });
  }

  start(): void {
    this.loop.start();
  }

  /** Wakes the loop early (e.g. right after a task was enqueued). */
  nudge(): void {
    this.loop.nudge();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }
}

/** Claims up to `limit` ready tasks and runs them. Returns how many ran. For tests and scripts. */
export async function runTasksOnce(
  db: Db,
  deps: TaskDeps,
  logger: Logger,
  limit = 10,
): Promise<number> {
  const tasks = await claimTasks(db, limit, TASK_LEASE_MS);
  await Promise.all(tasks.map((task) => runTask(db, deps, task, logger)));
  return tasks.length;
}

/** Runs one claimed task and settles it: done, or retried with exponential backoff. Never throws. */
async function runTask(db: Db, deps: TaskDeps, task: ClaimedTask, logger: Logger): Promise<void> {
  const log = logger.child({ taskId: task.id, kind: task.kind, attempt: task.attempts });
  try {
    // Unknown kinds (e.g. queued by a newer release during a deploy) fail and are retried later.
    if (!Object.hasOwn(TASK_HANDLERS, task.kind)) throw new Error(`Unknown task kind ${task.kind}`);
    const payload = TASK_PAYLOAD_SCHEMAS[task.kind].safeParse(task.payload);
    if (!payload.success) {
      // Retrying can't fix a malformed payload.
      log.error({ payload: task.payload, issues: payload.error.issues }, 'dropping invalid task');
      await completeTask(db, task);
      return;
    }
    const handler = TASK_HANDLERS[task.kind] as TaskHandler<TaskKind>;
    await handler({ ...deps, logger: log }, payload.data);
    await completeTask(db, task);
  } catch (err) {
    const delayMs = retryDelayMs(task.attempts);
    const message = err instanceof Error ? err.message : String(err);
    if (task.attempts >= LOUD_AFTER_ATTEMPTS) log.error({ err, delayMs }, 'task keeps failing');
    else log.warn({ err, delayMs }, 'task failed; will retry');
    await failTask(db, task, message, delayMs).catch((e: unknown) =>
      log.error({ err: e }, 'failed to release task'),
    );
  }
}
