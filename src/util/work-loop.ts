import type { Logger } from 'pino';

export interface WorkLoopOptions<T> {
  /** Used in log messages. */
  name: string;
  concurrency: number;
  /** How long to sleep when there was nothing to claim (a nudge or a finished job wakes it earlier). */
  idleMs: number;
  logger: Logger;
  /** Claims up to `limit` ready jobs; resolves to an empty list when there is nothing to do. */
  claim(limit: number): Promise<T[]>;
  /** Processes one claimed job and settles it in the database; a rejection is only logged. */
  run(job: T): Promise<void>;
  /** While this returns true nothing new is claimed; jobs already in flight finish normally. */
  isPaused?(): Promise<boolean>;
  /** `isPaused` is called at most once per this many milliseconds. Default 1000. */
  pauseCheckMs?: number;
}

/**
 * Keeps up to `concurrency` jobs in flight: as soon as one finishes, the loop claims another, so
 * one slow job never holds back the rest.
 */
export class WorkLoop<T> {
  private running = false;
  private finished?: Promise<void>;
  private readonly inflight = new Set<Promise<void>>();
  /** Set by `signal()`; lets a wake-up that arrives while the loop is busy cut its next sleep. */
  private signalled = false;
  private wake?: () => void;
  private pause?: { value: boolean; checkedAt: number };

  constructor(private readonly opts: WorkLoopOptions<T>) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.finished = this.loop();
  }

  /** Wakes the loop early, e.g. right after new work was enqueued. */
  nudge(): void {
    this.signal();
  }

  /** Stops claiming and waits for the jobs in flight. */
  async stop(): Promise<void> {
    this.running = false;
    this.signal();
    await this.finished;
  }

  private async loop(): Promise<void> {
    const { concurrency, idleMs, logger, name } = this.opts;
    while (this.running) {
      this.signalled = false;
      const free = concurrency - this.inflight.size;
      if (free > 0) {
        try {
          if (!(await this.isPaused())) {
            for (const job of await this.opts.claim(free)) this.track(job);
          }
        } catch (err) {
          logger.error({ err }, `${name}: claiming work failed`);
        }
      }
      // Every slot busy: a finishing job wakes us. Queue empty or paused: poll after idleMs.
      if (this.running) await this.sleep(idleMs);
    }
    await Promise.all(this.inflight);
  }

  private track(job: T): void {
    const done: Promise<void> = this.opts
      .run(job)
      .catch((err: unknown) => this.opts.logger.error({ err }, `${this.opts.name}: job failed`))
      .finally(() => {
        this.inflight.delete(done);
        this.signal();
      });
    this.inflight.add(done);
  }

  private async isPaused(): Promise<boolean> {
    if (!this.opts.isPaused) return false;
    const now = Date.now();
    if (!this.pause || now - this.pause.checkedAt >= (this.opts.pauseCheckMs ?? 1000)) {
      this.pause = { value: await this.opts.isPaused(), checkedAt: now };
    }
    return this.pause.value;
  }

  private signal(): void {
    this.signalled = true;
    this.wake?.();
  }

  private sleep(ms: number): Promise<void> {
    if (this.signalled) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.wake?.(), ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}
