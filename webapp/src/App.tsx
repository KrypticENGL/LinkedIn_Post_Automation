import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import { BackgroundFX } from "./components/BackgroundFX";
import { Navbar } from "./components/Navbar";
import { initTelegramWebApp } from "./lib/telegram";
import { NewPost } from "./pages/NewPost";
import { PreviousPosts } from "./pages/PreviousPosts";
import { Quota } from "./pages/Quota";

export default function App() {
  useEffect(() => {
    initTelegramWebApp();
  }, []);

  return (
    <>
      <BackgroundFX />
      <Navbar />
      <Routes>
        <Route path="/" element={<NewPost />} />
        <Route path="/posts" element={<PreviousPosts />} />
        <Route path="/quota" element={<Quota />} />
      </Routes>
    </>
  );
}
