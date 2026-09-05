import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Cursor-follow glow used on cards (the "spotlight border" trick Supabase/Vercel
 * marketing pages lean on). Writes plain CSS custom properties instead of state
 * so the glow tracks the pointer at native paint rate with no React re-renders.
 */
export function useSpotlight<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  const onPointerMove = (event: ReactPointerEvent<T>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
    el.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
  };

  return { ref, onPointerMove };
}
