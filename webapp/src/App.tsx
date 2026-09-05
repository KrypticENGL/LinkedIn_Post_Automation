import { useEffect, useRef, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { BackgroundFX } from "./components/BackgroundFX";
import { Navbar } from "./components/Navbar";
import type { ComposerEntry } from "./data/types";
import { getActivity } from "./lib/api";
import { initTelegramWebApp } from "./lib/telegram";
import { NewPost } from "./pages/NewPost";
import { PreviousPosts } from "./pages/PreviousPosts";
import { Quota } from "./pages/Quota";

const ACTIVITY_POLL_MS = 4000;

export default function App() {
  useEffect(() => {
    initTelegramWebApp();
  }, []);

  // Owned here, not in NewPost, so a draft-in-progress or command transcript
  // survives switching to Previous Posts/Quota and back — React Router unmounts the
  // page on every route change, which would otherwise reset NewPost's own state.
  const [composerValue, setComposerValue] = useState("");
  const [composerEntries, setComposerEntries] = useState<ComposerEntry[]>([]);

  // A `/topics` run (and the daily scan, draft reviews, publish results) reports
  // asynchronously through Telegram; the server tees those messages to
  // GET /api/activity so they land in the composer transcript here too. Polled
  // from App, not NewPost, so messages that arrive minutes later are still caught
  // while the user is on another tab.
  const activityCursor = useRef(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const { events, cursor } = await getActivity(activityCursor.current);
        if (stopped) return;
        activityCursor.current = cursor;
        if (events.length > 0) {
          setComposerEntries((prev) => {
            const seen = new Set(prev.map((e) => e.id));
            const added: ComposerEntry[] = events
              .filter((ev) => !seen.has(`a${ev.id}`))
              .map((ev) => ({ id: `a${ev.id}`, html: ev.html, url: ev.url, tone: ev.tone }));
            if (added.length === 0) return prev;
            return [...added.reverse(), ...prev].slice(0, 30);
          });
        }
      } catch {
        // Offline, or not authorised outside Telegram — just try again next tick.
      }
      if (!stopped) timer = setTimeout(poll, ACTIVITY_POLL_MS);
    }

    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <BackgroundFX />
      <Navbar />
      <Routes>
        <Route
          path="/"
          element={
            <NewPost
              value={composerValue}
              onValueChange={setComposerValue}
              entries={composerEntries}
              onEntriesChange={setComposerEntries}
            />
          }
        />
        <Route path="/posts" element={<PreviousPosts />} />
        <Route path="/quota" element={<Quota />} />
      </Routes>
    </>
  );
}
