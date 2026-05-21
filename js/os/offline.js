// Offline mode boot animations. Shown when navigator.onLine is false at boot,
// or when Firebase can't connect within a short timeout. Cycles through one
// of three randomly-picked animations that all reveal the BLIZZARD wordmark.

const ANIMS = ["convergence", "snowfall", "tiles"];
let stopped = false;
let runningEl = null;

export const OFFLINE_ANIMATIONS = ANIMS;

export function isOfflineNow() {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// Debug-only: pop the offline overlay and play exactly one named animation
// instead of the random-cycle reel. Used by the Ctrl+Alt+G debug menu.
export function previewOfflineAnimation(name) {
  if (!ANIMS.includes(name)) return;
  stopOfflineMode();
  stopped = false;
  const screen = document.createElement("div");
  screen.className = "offline-screen";
  screen.innerHTML = `
    <div class="offline-stage" data-bind="stage"></div>
    <div class="offline-retry" data-bind="close">Close preview</div>
    <div class="offline-status">Preview · ${name}</div>
  `;
  document.body.appendChild(screen);
  runningEl = screen;
  const stage = screen.querySelector('[data-bind="stage"]');
  renderAnimation(stage, name);
  screen.querySelector('[data-bind="close"]').addEventListener("click", stopOfflineMode);
  // Auto-close after 9 seconds so the preview doesn't trap the screen.
  setTimeout(() => { if (runningEl === screen) stopOfflineMode(); }, 9000);
}

export function startOfflineMode({ onRetry } = {}) {
  if (runningEl) return;
  stopped = false;
  const screen = document.createElement("div");
  screen.className = "offline-screen";
  screen.innerHTML = `
    <div class="offline-stage" data-bind="stage"></div>
    <div class="offline-retry" data-bind="retry">Try again</div>
    <div class="offline-status" data-bind="status">You are not connected</div>
  `;
  document.body.appendChild(screen);
  runningEl = screen;

  const stage = screen.querySelector('[data-bind="stage"]');
  const status = screen.querySelector('[data-bind="status"]');
  const retry = screen.querySelector('[data-bind="retry"]');

  retry.addEventListener("click", () => {
    if (navigator.onLine && typeof onRetry === "function") onRetry();
    else flashStatus(status, "Still no connection");
  });

  // 1) Show "You are not connected" for a bit.
  // 2) Switch to "Going to offline mode…"
  // 3) Cycle animations forever (random pick each time).
  setTimeout(() => {
    if (stopped) return;
    status.textContent = "Going to offline mode";
  }, 4000);
  setTimeout(() => {
    if (stopped) return;
    cycleAnimation(stage, status);
  }, 6500);

  window.addEventListener("online", onOnline, { once: false });
  function onOnline() {
    if (typeof onRetry === "function") onRetry();
  }
  screen._cleanup = () => {
    window.removeEventListener("online", onOnline);
  };
}

export function stopOfflineMode() {
  stopped = true;
  if (runningEl) {
    runningEl._cleanup?.();
    runningEl.remove();
    runningEl = null;
  }
}

function flashStatus(el, msg) {
  const prev = el.textContent;
  el.textContent = msg;
  setTimeout(() => { if (runningEl) el.textContent = prev; }, 2000);
}

function cycleAnimation(stage, status) {
  if (stopped) return;
  const pick = ANIMS[Math.floor(Math.random() * ANIMS.length)];
  status.textContent = "Offline mode";
  stage.innerHTML = "";
  renderAnimation(stage, pick);
  setTimeout(() => cycleAnimation(stage, status), 7500);
}

function renderAnimation(stage, name) {
  if (name === "convergence") {
    stage.classList.add("offline-convergence");
    stage.classList.remove("offline-snowfall", "offline-tiles-stage");
    stage.innerHTML = `
      <div class="offline-shard"></div>
      <div class="offline-shard"></div>
      <div class="offline-shard"></div>
      <div class="offline-shard"></div>
      <div class="offline-wordmark shimmer">Blizzard</div>
    `;
  } else if (name === "snowfall") {
    stage.classList.add("offline-snowfall");
    stage.classList.remove("offline-convergence", "offline-tiles-stage");
    const flakes = [];
    for (let i = 0; i < 18; i++) {
      const left = Math.floor(Math.random() * 100);
      const delay = (Math.random() * 1.5).toFixed(2);
      const dur = (3 + Math.random() * 2).toFixed(2);
      const gust = (Math.random() * 80 - 40).toFixed(0);
      flakes.push(`<span class="offline-snow"
        style="left:${left}vw; animation-duration: ${dur}s, 1.6s; animation-delay: ${delay}s, ${(parseFloat(dur) + parseFloat(delay) + 0.2).toFixed(2)}s; --gx: ${gust}vw">❄</span>`);
    }
    stage.innerHTML = flakes.join("") + `<div class="offline-wordmark shimmer">Blizzard</div>`;
  } else {
    stage.classList.add("offline-tiles-stage");
    stage.classList.remove("offline-convergence", "offline-snowfall");
    const letters = ["B", "L", "I", "Z", "Z", "A", "R", "D"];
    stage.innerHTML = `
      <div class="offline-tiles">
        <div class="offline-tile-row">
          ${letters.map((l) => `<div class="offline-tile shimmer">${l}</div>`).join("")}
        </div>
      </div>
    `;
  }
}
