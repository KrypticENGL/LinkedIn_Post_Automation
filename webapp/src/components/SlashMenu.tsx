import { motion } from "framer-motion";
import { createPortal } from "react-dom";
import type { SlashCommand } from "../data/commands";
import styles from "./SlashMenu.module.css";

const GROUP_LABEL: Record<SlashCommand["group"], string> = {
  compose: "Compose",
  status: "Status",
  account: "LinkedIn",
  control: "Control",
};

type Props = {
  commands: SlashCommand[];
  activeId: string | null;
  onSelect: (command: SlashCommand) => void;
  onHover: (id: string) => void;
  onClose: () => void;
};

/**
 * A centered command palette (Cmd+K style), portalled to <body> so it sits above
 * everything regardless of where the composer is scrolled. Filtering still happens
 * by typing into the textarea underneath — this only owns presentation.
 */
export function SlashMenu({ commands, activeId, onSelect, onHover, onClose }: Props) {
  const groups = (["compose", "status", "account", "control"] as const)
    .map((group) => ({ group, items: commands.filter((c) => c.group === group) }))
    .filter((g) => g.items.length > 0);

  return createPortal(
    <motion.div
      className={styles.backdrop}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        className={styles.panel}
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12, scale: 0.97 }}
        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
        role="listbox"
      >
        {commands.length === 0 && <div className={styles.empty}>No matching commands</div>}

        {groups.map(({ group, items }) => (
          <div key={group} className={styles.group}>
            <div className={styles.groupLabel}>{GROUP_LABEL[group]}</div>
            {items.map((cmd) => (
              <button
                key={cmd.id}
                type="button"
                role="option"
                aria-selected={cmd.id === activeId}
                className={`${styles.item} ${cmd.id === activeId ? styles.itemActive : ""}`}
                onMouseEnter={() => onHover(cmd.id)}
                onMouseDown={(e) => {
                  // Prevent the textarea from losing focus before onSelect runs.
                  e.preventDefault();
                  onSelect(cmd);
                }}
              >
                <span className={styles.label}>{cmd.label}</span>
                <span className={styles.hint}>{cmd.hint}</span>
              </button>
            ))}
          </div>
        ))}

        <div className={styles.footer}>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> select
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}
