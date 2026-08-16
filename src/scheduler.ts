import cron from "node-cron";
import { env } from "./config/env.js";
import { logger } from "./logger.js";
import { proposeTopics } from "./pipeline/dailyRun.js";

export function startScheduler(): cron.ScheduledTask {
  if (!cron.validate(env.DAILY_CRON)) {
    throw new Error(`DAILY_CRON is not a valid cron expression: "${env.DAILY_CRON}"`);
  }

  const task = cron.schedule(
    env.DAILY_CRON,
    () => {
      logger.info({ cron: env.DAILY_CRON }, "Daily topic run triggered");
      // Any previous day's unfinished drafts are retired at the same time.
      void proposeTopics({ announceStale: true });
    },
    { timezone: env.TIMEZONE },
  );

  logger.info({ cron: env.DAILY_CRON, timezone: env.TIMEZONE }, "Scheduler started");
  return task;
}
