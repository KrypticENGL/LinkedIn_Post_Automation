import { motion, type Variants } from "framer-motion";
import { useEffect, useState } from "react";
import { HexLoader } from "../components/HexLoader";
import { StatusBadge } from "../components/StatusBadge";
import type { PostSummary } from "../data/types";
import { ApiError, listPosts } from "../lib/api";
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

type LoadState = "loading" | "ready" | "error";

export function PreviousPosts() {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPosts(20)
      .then((data) => {
        if (cancelled) return;
        setPosts(data.posts);
        setState("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Could not load previous posts");
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Previous posts</h1>
        <p className={styles.subtitle}>Every draft Sigmσid has written, and where it ended up.</p>
      </div>

      {state === "loading" && (
        <p className={styles.status}>
          <HexLoader label="Loading previous posts" />
        </p>
      )}
      {state === "error" && <p className={styles.statusError}>{error}</p>}
      {state === "ready" && posts.length === 0 && (
        <p className={styles.status}>No drafts yet — start one from New post.</p>
      )}

      <motion.div className={styles.list} variants={container} initial="hidden" animate="show">
        {posts.map((post) => (
          <motion.article key={post.id} className={styles.card} variants={item}>
            <div className={styles.cardTop}>
              <h2 className={styles.cardTitle}>{post.title}</h2>
              <StatusBadge status={post.status} />
            </div>
            {post.snippet && <p className={styles.snippet}>{post.snippet}</p>}
            <div className={styles.meta}>
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
