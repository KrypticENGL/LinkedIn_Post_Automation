import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { BackgroundFX } from "./components/BackgroundFX";
import { Navbar } from "./components/Navbar";
import type { ComposerEntry } from "./data/types";
import { initTelegramWebApp } from "./lib/telegram";
import { NewPost } from "./pages/NewPost";
import { PreviousPosts } from "./pages/PreviousPosts";
import { Quota } from "./pages/Quota";

export default function App() {
  useEffect(() => {
    initTelegramWebApp();
  }, []);

  // Owned here, not in NewPost, so a draft-in-progress or command transcript
  // survives switching to Previous Posts/Quota and back — React Router unmounts the
  // page on every route change, which would otherwise reset NewPost's own state.
  const [composerValue, setComposerValue] = useState("");
  const [composerEntries, setComposerEntries] = useState<ComposerEntry[]>([]);

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
