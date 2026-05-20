// Bootstrap: decide what to show (setup screen / auth screen / desktop).
import { initAuthUI, watchAuth } from "./auth.js";
import { initFS, setCurrentUsername } from "./fs.js";
import { bootDesktop, shutdownDesktop } from "./os/desktop.js";
import { seedGamesIfEmpty, ensureDefaultChannels, killAllMyLiveStreams } from "./firebase.js";

const $ = (id) => document.getElementById(id);

(function boot() {
  setStatus("Please sign in to your account");
  initAuthUI();

  watchAuth(async (user) => {
    if (!user) {
      // Logged out: show auth screen.
      shutdownDesktop();
      $("boot").classList.add("hidden");
      $("desktop").classList.add("hidden");
      $("auth").classList.remove("hidden");
      return;
    }
    // Logged in: prepare environment, then show desktop.
    setStatus("Preparing your session…");
    $("auth").classList.add("hidden");
    $("boot").classList.remove("hidden");

    try {
      setCurrentUsername(user.username);
      await initFS(user.uid);
      await Promise.all([
        ensureDefaultChannels(),
        seedGamesIfEmpty(),
        // Clean up any ghost streams left over from a previous closed tab.
        killAllMyLiveStreams(user.uid).catch(() => {})
      ]);
    } catch (e) {
      console.error("Init error:", e);
    }

    bootDesktop(user, {});
    $("boot").classList.add("hidden");
    $("desktop").classList.remove("hidden");
  });
})();

function setStatus(msg) {
  const el = $("boot-status");
  if (el) el.textContent = msg;
}
