import { useEffect, useRef } from "react";
import styles from "./BackgroundFX.module.css";

const NOISE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>
      <filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter>
      <rect width='100%' height='100%' filter='url(#n)'/>
    </svg>`,
  );

/** Low native resolution — CSS scales it up unsmoothed, so each cell reads as a fat pixel. */
const COLS = 96;
const ROWS = 54;

/** A limited, DOS-era-sized swatch instead of a smooth gradient — quantised plasma reads as retro. */
const PALETTE = ["#050506", "#0d2420", "#134a37", "#1c6b4d", "#3ecf8e", "#7fe0b3", "#8b7bff", "#ff6ea8"];

/** Classic demoscene plasma: sum of sines sampled on a coarse grid, quantised into PALETTE bands. */
function drawPlasma(ctx: CanvasRenderingContext2D, t: number) {
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const value =
        Math.sin(x / 7 + t) +
        Math.sin(y / 5 - t * 1.3) +
        Math.sin((x + y) / 9 + t * 0.7) +
        Math.sin(Math.sqrt((x - COLS / 2) ** 2 + (y - ROWS / 2) ** 2) / 4 - t);
      const band = Math.min(PALETTE.length - 1, Math.max(0, Math.floor(((value + 4) / 8) * PALETTE.length)));
      ctx.fillStyle = PALETTE[band];
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

/**
 * Fixed, whole-page ambience: a coarse, unsmoothed plasma field (the sum-of-sines
 * trick behind every 90s demoscene intro) standing in for the old blurred gradient
 * blobs, under a faint dot grid, CRT scanlines, and a grain layer. Decoration only —
 * lives outside page flow and never intercepts clicks.
 */
export function BackgroundFX() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !ctx) return;

    canvas.width = COLS;
    canvas.height = ROWS;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let raf = 0;
    let last = 0;
    let t = 0;
    const FRAME_MS = 1000 / 18; // deliberately choppy — smooth 60fps plasma reads as modern, not retro

    const tick = (now: number) => {
      if (now - last >= FRAME_MS) {
        last = now;
        t += 0.05;
        drawPlasma(ctx, t);
      }
      raf = requestAnimationFrame(tick);
    };

    if (reduceMotion) {
      drawPlasma(ctx, 0);
    } else {
      raf = requestAnimationFrame(tick);
    }

    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={styles.root} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.plasma} />
      <div className={styles.grid} />
      <div className={styles.scanlines} />
      <div className={styles.grain} style={{ backgroundImage: `url("${NOISE}")` }} />
      <div className={styles.vignette} />
    </div>
  );
}
