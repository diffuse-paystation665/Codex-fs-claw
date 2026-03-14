import { Logger } from "./logger.js";
import { SessionStore } from "./session-store.js";
import type { CronJobRecord } from "./types.js";

export class CronScheduler {
  private readonly logger: Logger;
  private readonly activeJobIds = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly store: SessionStore,
    private readonly pollIntervalMs: number,
    parentLogger: Logger,
    private readonly onDueJob: (job: CronJobRecord) => Promise<void>,
  ) {
    this.logger = parentLogger.child("cron");
  }

  public start(): void {
    if (this.timer) {
      return;
    }

    void this.poll();
    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    const dueJobs = this.store.listDueCronJobs(new Date().toISOString());

    for (const job of dueJobs) {
      if (this.activeJobIds.has(job.id)) {
        continue;
      }

      this.activeJobIds.add(job.id);
      void this.onDueJob(job)
        .catch((error: unknown) => {
          this.logger.error("Failed to execute due cron job", {
            jobId: job.id,
            openId: job.openId,
            error,
          });
        })
        .finally(() => {
          this.activeJobIds.delete(job.id);
        });
    }
  }
}
