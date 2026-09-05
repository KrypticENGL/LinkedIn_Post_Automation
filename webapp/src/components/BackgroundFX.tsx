import styles from "./BackgroundFX.module.css";

const NOISE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>
      <filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter>
      <rect width='100%' height='100%' filter='url(#n)'/>
    </svg>`,
  );

/**
 * Fixed, whole-page ambience: three slow-drifting gradient blobs behind a faint
 * dot grid, topped with a grain layer. Same family of elements as
 * select.supabase.com's hero — decoration only, so it lives outside page flow
 * and never intercepts clicks.
 */
export function BackgroundFX() {
  return (
    <div className={styles.root} aria-hidden="true">
      <div className={`${styles.blob} ${styles.blobA}`} />
      <div className={`${styles.blob} ${styles.blobB}`} />
      <div className={`${styles.blob} ${styles.blobC}`} />
      <div className={styles.grid} />
      <div className={styles.grain} style={{ backgroundImage: `url("${NOISE}")` }} />
      <div className={styles.vignette} />
    </div>
  );
}
