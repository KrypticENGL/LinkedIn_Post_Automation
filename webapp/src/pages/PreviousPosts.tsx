import { motion, type Variants } from "framer-motion";
import { StatusBadge } from "../components/StatusBadge";
import { MOCK_POSTS } from "../data/mock";
import styles from "./PreviousPosts.module.css";

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06 } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PreviousPosts() {
  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Previous posts</h1>
        <p className={styles.subtitle}>Every draft Sigmσid has written, and where it ended up.</p>
      </div>

      <motion.div className={styles.list} variants={container} initial="hidden" animate="show">
        {MOCK_POSTS.map((post) => (
          <motion.article key={post.id} className={styles.card} variants={item}>
            <div className={styles.cardTop}>
              <h2 className={styles.cardTitle}>{post.title}</h2>
              <StatusBadge status={post.status} />
            </div>
            <p className={styles.snippet}>{post.snippet}</p>
            <div className={styles.meta}>
              <span className={styles.metaModel}>{post.model}</span>
              <span className={styles.dotSep} />
              <span>
                {post.revisionCount} revision{post.revisionCount === 1 ? "" : "s"}
              </span>
              <span className={styles.dotSep} />
              <span>{formatDate(post.createdAt)}</span>
            </div>
          </motion.article>
        ))}
      </motion.div>
    </div>
  );
}
