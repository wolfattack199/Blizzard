// Bootstrap: decide what to show (auth screen or desktop).
import { initAuthUI, watchAuth } from "./auth.js";
import { initFS, setCurrentUsername } from "./fs.js";
import { bootDesktop, shutdownDesktop } from "./os/desktop.js";
import {
  seedGamesIfEmpty, ensureDefaultChannels, ensureDefaultStoreApps, killAllMyLiveStreams,
  loadUser, acknowledgeWarnings, ensureStorageBackfill
} from "./firebase.js";
import { ensureAchievementsCatalog, initAchievements } from "./achievements.js";
import { startOfflineMode, stopOfflineMode } from "./os/offline.js";
import { showToast } from "./os/toasts.js";
import { startUpdateChecker } from "./os/updates.js";
import { startGoLiveNotifier, stopGoLiveNotifier } from "./os/golive.js";
import { startCallListener, stopCallListener } from "./os/calls.js";
import { setupDebugHotkey, setDebugUser } from "./os/debug.js";

const $ = (id) => document.getElementById(id);
let authRun = 0;
window.__blizzardMainLoaded = true;

(function boot() {
  showBoot("Checking your session...");
  if (!navigator.onLine) showConnectionTrouble();
  initAuthUI();
  setupConnectionWatch();
  setupMentionToasts();
  startUpdateChecker();

  watchAuth(async (user) => {
    const run = ++authRun;

    if (!user) {
      shutdownDesktop();
      stopGoLiveNotifier();
      stopCallListener();
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
      const account = await loadUser(user.uid).catch(() => null);
      if (run !== authRun) return;
      const allowed = await enforceAccountState(user, account);
      if (!allowed) return;

      setCurrentUsername(user.username);
      setStatus("Calculating your storage...");
      await ensureStorageBackfill(user.uid).catch((err) => console.warn("Storage backfill skipped:", err));
      setStatus("Preparing your files...");
      await Promise.all([
        initFS(user.uid),
        ensureDefaultChannels(),
        ensureDefaultStoreApps(),
        ensureAchievementsCatalog().catch(() => {}),
        initAchievements(user.uid).catch(() => {}),
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
    const account = await loadUser(user.uid).catch(() => null);
    bootDesktop({ ...user, ...(account || {}), profile: account?.profile || user.profile || {} }, {});
    startGoLiveNotifier(user.uid);
    startCallListener(user.uid, user.username);
    setupDebugHotkey(user);
    setDebugUser(user);
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

function setupMentionToasts() {
  // GuildWire dispatches a `blizzard:mention` event when a message containing
  // @<me> arrives. Pop a toast in the bottom-right corner.
  document.addEventListener("blizzard:mention", (e) => {
    const d = e.detail || {};
    showToast({
      title: `@${d.senderUsername || "someone"} mentioned you`,
      body: d.text || "",
      context: d.context || "",
      user: { uid: d.senderUid, username: d.senderUsername },
      duration: 10000,
      onClick: () => {
        // Bring GuildWire to the front so the user can read the message.
        if (window.bzLaunchApp) window.bzLaunchApp(d.appId || "messenger");
      }
    });
  });
}

function setupConnectionWatch() {
  window.addEventListener("offline", () => {
    if (!$("desktop").classList.contains("hidden")) return;
    $("auth").classList.add("hidden");
    showConnectionTrouble();
  });
  window.addEventListener("online", () => {
    stopOfflineMode();
    setStatus("Internet reconnected. Restarting Blizzard...");
    setTimeout(() => location.reload(), 700);
  });
}

function showConnectionTrouble() {
  // Hide the normal boot screen and start the offline animation reel.
  hideBoot();
  startOfflineMode({
    onRetry: () => {
      stopOfflineMode();
      location.reload();
    }
  });
}

async function enforceAccountState(user, account) {
  if (!account) return true;
  if (account.banned) {
    showLockout("This Blizzard account is banned.", "If this seems wrong, ask an admin to review it.");
    return false;
  }
  const timeout = account.timeout;
  if (timeout?.until && timeout.until > Date.now()) {
    showLockout(
      "This account is timed out.",
      `${timeout.reason || "No reason provided."}\nUntil ${new Date(timeout.until).toLocaleString()}`
    );
    return false;
  }
  const warnings = Object.entries(account.warnings || {})
    .map(([id, warning]) => ({ id, ...warning }))
    .filter((warning) => warning && !warning.acknowledgedAt);
  if (warnings.length === 0) return true;
  await showWarningModal(user.uid, warnings);
  return true;
}

function showLockout(title, detail) {
  $("auth").classList.add("hidden");
  showBoot(title);
  $("boot").classList.add("boot-loop");
  setStatus(detail);
}

function showWarningModal(uid, warnings) {
  return new Promise((resolve) => {
    hideBoot();
    const overlay = document.createElement("div");
    overlay.className = "account-modal";
    overlay.innerHTML = `
      <div class="account-modal-card">
        <h2>Account warning</h2>
        <div class="account-modal-copy">
          ${warnings.map((warning) => `
            <div class="account-warning">
              <div>${escapeModal(warning.text || "A moderator sent you a warning.")}</div>
              <small>${new Date(warning.ts || Date.now()).toLocaleString()}</small>
            </div>
          `).join("")}
        </div>
        <button class="primary" data-act="ack">Acknowledge</button>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('[data-act="ack"]').addEventListener("click", async () => {
      await acknowledgeWarnings(uid, warnings.map((warning) => warning.id)).catch(() => {});
      overlay.remove();
      showBoot("Continuing sign in...");
      resolve();
    });
  });
}

function escapeModal(value) {
  return String(value || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[c]));
}
