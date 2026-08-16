import { cancelStaleDrafts, createTopicBatch } from "../db/repo.js";
import type { TopicBatch } from "../db/schema.js";
import { errorMessage, logger } from "../logger.js";
import { getConnectedAccount } from "../linkedin/oauth.js";
import { curateTopics } from "../topics/curate.js";
import { deleteMessage, notify, sendTopicOptions, sendWorkingNotice } from "../telegram/notify.js";

let inFlight: Promise<TopicBatch | null> | null = null;

async function run(options: { announceStale: boolean }): Promise<TopicBatch | null> {
  const notice = await sendWorkingNotice("📰 Scanning today's business headlines…");

  try {
    if (options.announceStale) {
      const cancelled = await cancelStaleDrafts();
      if (cancelled > 0) {
        logger.info({ cancelled }, "Cancelled drafts left open from a previous run");
      }
    }

    const topics = await curateTopics();
    const batch = await createTopicBatch(topics);
    await deleteMessage(notice);
    await sendTopicOptions(batch);

    const account = await getConnectedAccount();
    if (!account) {
      await notify(
        "🔐 Heads up: no LinkedIn account is connected yet, so nothing can be published. Run /auth when you get a moment.",
      );
    }

    return batch;
  } catch (error) {
    await deleteMessage(notice);
    const reason = errorMessage(error);
    logger.error({ err: reason }, "Daily topic run failed");
    await notify(
      `❗️ Could not put together today's topics.\n<code>${reason}</code>\n\nTry again with /topics.`,
    );
    return null;
  }
}

/**
 * Fetches hot topics and offers them in Telegram. Guarded so a cron tick and a
 * manual /topics command cannot run two scans at once.
 */
export async function proposeTopics(options: { announceStale?: boolean } = {}): Promise<TopicBatch | null> {
  if (inFlight) {
    logger.info("Topic proposal already in flight; reusing it");
    return inFlight;
  }

  inFlight = run({ announceStale: options.announceStale ?? false }).finally(() => {
    inFlight = null;
  });

  return inFlight;
}
