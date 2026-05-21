// Owner-only debug menu, opened with Ctrl+Alt+G. Provides one-click test
// triggers for the bits that are normally hard to reproduce (offline reel,
// notification toasts, ringing call, warning modal, etc.). Refuses to open
// for any account other than the OS owner.
import { previewOfflineAnimation, OFFLINE_ANIMATIONS, startOfflineMode, stopOfflineMode } from "./offline.js";
import { showToast } from "./toasts.js";

const OWNER_USERNAME = "wolfattack199";
let overlay = null;
let currentUser = null;

export function setupDebugHotkey(user) {
  currentUser = user;
  // Bind once globally.
  if (window.__bzDebugBound) return;
  window.__bzDebugBound = true;
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || !e.altKey) return;
    if ((e.key || "").toLowerCase() !== "g") return;
    e.preventDefault();
    toggle();
  }, true);
}

export function setDebugUser(user) { currentUser = user; }

function toggle() {
  if (overlay) { close(); return; }
  if ((currentUser?.username || "").toLowerCase() !== OWNER_USERNAME) {
    // Silent for non-owners — same idea as the `ghiy` terminal command.
    return;
  }
  open();
}

function close() {
  overlay?.remove();
  overlay = null;
}

function open() {
  overlay = document.createElement("div");
  overlay.className = "debug-overlay";
  overlay.innerHTML = `
    <div class="debug-card">
      <div class="debug-head">
        <span style="font-weight:700;letter-spacing:0.5px">🔧 Debug menu</span>
        <span class="muted" style="font-size:11px;margin-left:8px">Ctrl+Alt+G</span>
        <span class="grow" style="flex:1"></span>
        <button data-act="close" style="padding:2px 10px">Close</button>
      </div>
      <div class="debug-body">
        ${section("Offline animations", [
          ...OFFLINE_ANIMATIONS.map((n) => ({ label: "Play · " + n, act: "anim-" + n })),
          { label: "Run full offline reel", act: "offline-reel" },
          { label: "Stop offline overlay", act: "offline-stop" }
        ])}

        ${section("Toasts", [
          { label: "Mention toast (GuildWire)", act: "toast-mention" },
          { label: "Go-live toast",              act: "toast-golive" },
          { label: "Generic info toast",         act: "toast-info" },
          { label: "Long body + truncation",     act: "toast-long" }
        ])}

        ${section("Calls", [
          { label: "Simulate incoming ring",     act: "ring" }
        ])}

        ${section("System", [
          { label: "Update-available toast",     act: "update" },
          { label: "Reload page",                act: "reload" }
        ])}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-act="close"]').addEventListener("click", close);
  overlay.querySelectorAll("[data-act]").forEach((b) => {
    if (b.dataset.act === "close") return;
    b.addEventListener("click", () => handle(b.dataset.act));
  });
}

function section(title, buttons) {
  return `
    <div class="debug-section">
      <div class="debug-section-head">${title}</div>
      <div class="debug-section-body">
        ${buttons.map((b) => `<button data-act="${b.act}">${b.label}</button>`).join("")}
      </div>
    </div>
  `;
}

function handle(act) {
  // Offline animations
  if (act.startsWith("anim-")) {
    previewOfflineAnimation(act.slice(5));
    close();
    return;
  }
  if (act === "offline-reel") {
    close();
    startOfflineMode({ onRetry: () => { stopOfflineMode(); } });
    return;
  }
  if (act === "offline-stop") { stopOfflineMode(); return; }

  // Toasts
  if (act === "toast-mention") {
    showToast({
      title: "@testuser mentioned you",
      body: "Hey @" + (currentUser?.username || "you") + " come look at this!",
      context: "#general",
      user: { uid: "test", username: "testuser" },
      duration: 10000,
      onClick: () => { if (window.bzLaunchApp) window.bzLaunchApp("messenger"); }
    });
    return;
  }
  if (act === "toast-golive") {
    showToast({
      title: "@friend is live!",
      body: "Building a Blizzard clone live, come hang out",
      context: "blizz://stream.blz",
      user: { uid: "test", username: "friend" },
      duration: 10000
    });
    return;
  }
  if (act === "toast-info") {
    showToast({
      title: "Just a heads-up",
      body: "This is what a plain info toast looks like.",
      duration: 6000,
      glyph: "ℹ"
    });
    return;
  }
  if (act === "toast-long") {
    showToast({
      title: "Long message preview",
      body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.",
      context: "Truncation test",
      duration: 12000
    });
    return;
  }

  // Calls
  if (act === "ring") {
    // Fake an incoming-ring overlay locally — no Firebase, no WebRTC.
    const av = `background:linear-gradient(135deg, var(--accent), var(--accent-2))`;
    const ring = document.createElement("div");
    ring.className = "call-ringer";
    ring.innerHTML = `
      <div class="call-ringer-card">
        <div class="call-avatar-big ringing" style="${av}">T</div>
        <div class="call-name-big">@testcaller</div>
        <div class="call-sub-big">Incoming voice call (debug)</div>
        <div class="call-controls-big">
          <button class="danger" data-act="decline">📞</button>
          <button class="accept" data-act="accept">✓</button>
        </div>
      </div>
    `;
    document.body.appendChild(ring);
    ring.querySelector('[data-act="decline"]').onclick = () => ring.remove();
    ring.querySelector('[data-act="accept"]').onclick  = () => {
      ring.remove();
      showToast({ title: "Pretend call accepted", body: "(no actual WebRTC since this is a fake ring)", duration: 4000 });
    };
    return;
  }

  // System
  if (act === "update") {
    showToast({
      title: "You have an outdated version",
      body: "Blizzard has a newer build on GitHub. Click here to update.",
      context: "Update hub",
      glyph: "⬆",
      duration: 10000
    });
    return;
  }
  if (act === "reload") { location.reload(); return; }
}
