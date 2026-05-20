// Bootstrap: decide what to show (auth screen or desktop).
import { initAuthUI, watchAuth } from "./auth.js";
import { initFS, setCurrentUsername } from "./fs.js";
import { bootDesktop, shutdownDesktop } from "./os/desktop.js";
import { seedGamesIfEmpty, ensureDefaultChannels, ensureDefaultStoreApps, killAllMyLiveStreams } from "./firebase.js";

const $ = (id) => document.getElementById(id);
let authRun = 0;
window.__blizzardMainLoaded = true;
const CONNECTION_TROUBLE = "Having trouble connecting. Reconnect to the internet and Blizzard will keep trying...";

(function boot() {
  showBoot("Checking your session...");
  if (!navigator.onLine) showConnectionTrouble();
  initAuthUI();
  setupConnectionWatch();

  watchAuth(async (user) => {
    const run = ++authRun;

    if (!user) {
      shutdownDesktop();
      $("desktop").classList.add("hidden");
      if (!navigator.onLine) {
        $("auth").classList.add("hidden");
        showConnectionTrouble();
        return;
      }
      hideBoot();
      $("auth").classList.remove("hidden");
      return;
    }

    $("desktop").classList.add("hidden");
    $("auth").classList.add("hidden");
    showBoot(`Signing in as @${user.username}...`);

    try {
      setCurrentUsername(user.username);
      setStatus("Preparing your files...");
      await Promise.all([
        initFS(user.uid),
        ensureDefaultChannels(),
        ensureDefaultStoreApps(),
        seedGamesIfEmpty(),
        // Clean up any ghost streams left over from a previous closed tab.
        killAllMyLiveStreams(user.uid).catch(() => {}),
        wait(1300)
      ]);

      if (run !== authRun) return;
      setStatus("Snapping your workspace together...");
      await wait(420);
    } catch (e) {
      console.error("Init error:", e);
      if (run !== authRun) return;
      setStatus("Some cloud services are unavailable. Opening Blizzard...");
      await wait(650);
    }

    if (run !== authRun) return;
    bootDesktop(user, {});
    $("desktop").classList.remove("hidden");
    hideBoot();
  });
})();

function showBoot(msg) {
  const boot = $("boot");
  setStatus(msg);
  boot.classList.remove("hidden");
  boot.classList.remove("boot-loop");
  boot.classList.remove("boot-run");
  // Force a reflow so the snap animation replays on each login.
  void boot.offsetWidth;
  boot.classList.add("boot-run");
}

function hideBoot() {
  $("boot").classList.add("hidden");
}

function setStatus(msg) {
  const el = $("boot-status");
  if (el) el.textContent = msg;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupConnectionWatch() {
  window.addEventListener("offline", () => {
    if (!$("desktop").classList.contains("hidden")) return;
    $("auth").classList.add("hidden");
    showConnectionTrouble();
  });
  window.addEventListener("online", () => {
    if ($("boot").classList.contains("hidden")) return;
    setStatus("Internet reconnected. Restarting Blizzard...");
    setTimeout(() => location.reload(), 700);
  });
}

function showConnectionTrouble() {
  showBoot(CONNECTION_TROUBLE);
  $("boot").classList.add("boot-loop");
}
