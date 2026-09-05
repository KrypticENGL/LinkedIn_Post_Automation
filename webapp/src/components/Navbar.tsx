import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import styles from "./Navbar.module.css";

const LINKS = [
  { to: "/", label: "New post", end: true },
  { to: "/posts", label: "Previous posts", end: false },
  { to: "/quota", label: "Quota", end: false },
];

export function Navbar() {
  const [open, setOpen] = useState(false);

  // Close the mobile panel on any route change / outside resize back to desktop.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 720) setOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <header className={styles.header}>
      <nav className={styles.nav}>
        <NavLink to="/" className={styles.brand} onClick={() => setOpen(false)}>
          Sigm<span className={styles.sigma}>σ</span>id
        </NavLink>

        <div className={styles.links}>
          {LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.end}
              className={({ isActive }) => `${styles.link} ${isActive ? styles.linkActive : ""}`}
            >
              {link.label}
            </NavLink>
          ))}
        </div>

        <button
          className={styles.menuToggle}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className={`${styles.bar} ${open ? styles.barOpenTop : ""}`} />
          <span className={`${styles.bar} ${open ? styles.barOpenMid : ""}`} />
          <span className={`${styles.bar} ${open ? styles.barOpenBottom : ""}`} />
        </button>
      </nav>

      <div className={`${styles.mobilePanel} ${open ? styles.mobilePanelOpen : ""}`}>
        {LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            onClick={() => setOpen(false)}
            className={({ isActive }) => `${styles.mobileLink} ${isActive ? styles.linkActive : ""}`}
          >
            {link.label}
          </NavLink>
        ))}
      </div>
    </header>
  );
}
