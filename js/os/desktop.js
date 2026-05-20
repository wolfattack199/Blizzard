// Desktop, taskbar, start menu, context menu wiring.
import { APPS, getApp } from "./registry.js";
import { openWindow, onWindowsChanged, toggleTaskbar, focusWindow, closeAllWindows } from "./wm.js";
import { doSignOut } from "../auth.js";
import { escapeHtml } from "./wm.js";
import { setAppearanceUser, applyAppearance } from "./appearance.js";
import { subscribeInstalledApps, getStoreApp, subscribeDesktopIconPositions, saveDesktopIconPositions } from "../firebase.js";

let currentUser = null;
let runtimeServices = null;
let installedApps = []; // from Firebase, list of app entries
let installedAppsUnsub = null;
let iconPositions = {};
let iconPositionsUnsub = null;
let iconPositionsSaveTimer = null;
let iconPositionsDirty = false;

function availableApps() {
  // Non-storeOnly built-in apps + storeOnly apps that are installed + user-published installed apps
  const installedIds = new Set(installedApps.map((a) => a.id));
  const builtinVisible = APPS.filter((a) => !a.storeOnly || installedIds.has(a.id));
  const userInstalled = installedApps
    .filter((a) => !a.builtin) // user-published code apps
    .map((a) => ({
      id: a.id,
      name: a.name,
      glyph: a.glyph || "📦",
      mount: async (root) => {
        // Fetch the app code fresh from the DB at launch time so updates
        // from the author propagate automatically, and users can't edit
        // their local copy.
        root.innerHTML = `<div style="padding:30px;color:var(--text-2);text-align:center">Loading…</div>`;
        let code;
        try {
          const fresh = await getStoreApp(a.id);
          code = fresh?.code;
        } catch {}
        if (!code) {
          root.innerHTML = `<div style="padding:30px;color:var(--text-1);text-align:center">This app is no longer available.</div>`;
          return;
        }
        root.innerHTML = "";
        const iframe = document.createElement("iframe");
        iframe.style.cssText = "width:100%;height:100%;border:none;background:#fff";
        iframe.sandbox = "allow-scripts allow-same-origin allow-forms";
        iframe.srcdoc = code;
        root.appendChild(iframe);
      },
      width: 880, height: 600,
      desktop: false,
      userApp: true
    }));
  return [...builtinVisible, ...userInstalled];
}

export function bootDesktop(user, services) {
  currentUser = user;
  runtimeServices = services;

  setAppearanceUser(user.uid);
  applyAppearance();

  setupIconPositionSync(user.uid);
  window.bzFlushDesktopLayout = flushDesktopLayout;

  // Subscribe to installed apps from Firebase so installs from the Store
  // appear in the start menu in real time.
  if (installedAppsUnsub) installedAppsUnsub();
  installedAppsUnsub = subscribeInstalledApps(user.uid, (list) => {
    installedApps = list || [];
    renderStartMenu();
    renderDesktopIcons();
  });

  renderDesktopIcons();
  renderStartMenu();
  renderTaskbarApps([]);
  setupClock();
  setupTrayUser();
  setupStartButton();
  setupSearch();
  setupContextMenus();

  onWindowsChanged((wins) => renderTaskbarApps(wins));
}

export function shutdownDesktop() {
  flushDesktopLayout().catch(() => {});
  closeAllWindows();
  document.getElementById("desktop-surface").innerHTML = "";
  document.getElementById("start-apps").innerHTML = "";
  document.getElementById("taskbar-apps").innerHTML = "";
  if (installedAppsUnsub) { installedAppsUnsub(); installedAppsUnsub = null; }
  if (iconPositionsUnsub) { iconPositionsUnsub(); iconPositionsUnsub = null; }
}

export function launchApp(id, extraCtx = {}) {
  let app = getApp(id);
  if (!app) app = availableApps().find((a) => a.id === id);
  if (!app) return;
  openWindow({
    id: app.id,
    title: app.name,
    glyph: app.glyph,
    width: app.width,
    height: app.height,
    render: ({ root, win }) => app.mount(root, { ...runtimeServices, user: currentUser, win, launchApp, ...extraCtx })
  });
  hideStartMenu();
}

// Open an HTML payload in a Blizzard browser tab. Use the active browser
// if there is one, otherwise launch a new browser instance.
export function openInBrowserTab(html, title) {
  const haveBrowser = currentWindows.some((w) => (w.appId || w.id) === "browser");
  if (haveBrowser) {
    document.dispatchEvent(new CustomEvent("blizzard:open-html-tab", { detail: { html, title } }));
  } else {
    launchApp("browser", { initialHtml: html, initialTitle: title });
  }
}
window.bzOpenInBrowserTab = openInBrowserTab;

const ICON_W = 88, ICON_H = 96, GRID_GAP = 8, GRID_PAD = 20;

function iconPositionsKey() {
  return `blizzard.iconPositions.${currentUser?.uid || "guest"}`;
}
function loadLocalIconPositions() {
  try { return JSON.parse(localStorage.getItem(iconPositionsKey()) || "{}"); }
  catch { return {}; }
}
function saveLocalIconPositions(map) {
  localStorage.setItem(iconPositionsKey(), JSON.stringify(map));
}
function loadIconPositions() {
  return iconPositions || {};
}
function saveIconPositions(map, { immediate = false } = {}) {
  iconPositions = { ...(map || {}) };
  saveLocalIconPositions(iconPositions);
  iconPositionsDirty = true;

  if (iconPositionsSaveTimer) {
    clearTimeout(iconPositionsSaveTimer);
    iconPositionsSaveTimer = null;
  }

  if (immediate) {
    return flushDesktopLayout({ capture: false });
  }

  iconPositionsSaveTimer = setTimeout(() => {
    flushDesktopLayout({ capture: false }).catch((err) => console.warn("Desktop layout sync failed:", err));
  }, 500);
}

function setupIconPositionSync(uid) {
  if (iconPositionsUnsub) iconPositionsUnsub();
  if (iconPositionsSaveTimer) {
    clearTimeout(iconPositionsSaveTimer);
    iconPositionsSaveTimer = null;
  }

  iconPositionsDirty = false;
  iconPositions = loadLocalIconPositions();

  iconPositionsUnsub = subscribeDesktopIconPositions(uid, (remotePositions) => {
    const remoteHasPositions = Object.keys(remotePositions || {}).length > 0;
    if (iconPositionsDirty && remoteHasPositions) return;
    if (remoteHasPositions) {
      iconPositions = remotePositions;
      iconPositionsDirty = false;
      saveLocalIconPositions(iconPositions);
      renderDesktopIcons();
      return;
    }

    const localPositions = loadLocalIconPositions();
    if (Object.keys(localPositions).length > 0) {
      iconPositions = localPositions;
      saveIconPositions(iconPositions, { immediate: true })
        .catch((err) => console.warn("Desktop layout migration failed:", err));
      renderDesktopIcons();
      return;
    }

    iconPositions = {};
    renderDesktopIcons();
  });
}

function captureIconPositionsFromDOM() {
  const next = { ...loadIconPositions() };
  document.querySelectorAll(".desk-icon[data-app-id]").forEach((icon) => {
    next[icon.dataset.appId] = {
      x: parseInt(icon.style.left, 10) || 0,
      y: parseInt(icon.style.top, 10) || 0
    };
  });
  return next;
}

export async function flushDesktopLayout({ capture = true } = {}) {
  if (iconPositionsSaveTimer) {
    clearTimeout(iconPositionsSaveTimer);
    iconPositionsSaveTimer = null;
  }
  if (!currentUser?.uid) return;

  if (capture) iconPositions = captureIconPositionsFromDOM();
  saveLocalIconPositions(iconPositions);
  await saveDesktopIconPositions(currentUser.uid, iconPositions);
  iconPositionsDirty = false;
}

function pinnedKey() { return `blizzard.pinned.${currentUser?.uid || "guest"}`; }
function loadPinned() {
  try { return JSON.parse(localStorage.getItem(pinnedKey()) || "[]"); }
  catch { return []; }
}
function savePinned(arr) {
  localStorage.setItem(pinnedKey(), JSON.stringify(arr));
}
function isPinned(appId) { return loadPinned().includes(appId); }
function togglePinned(appId) {
  const arr = loadPinned();
  const i = arr.indexOf(appId);
  if (i >= 0) arr.splice(i, 1);
  else arr.push(appId);
  savePinned(arr);
  renderTaskbarApps(currentWindows);
}

let currentWindows = [];

function defaultPositionFor(index) {
  const surface = document.getElementById("desktop-surface");
  const cols = Math.max(1, Math.floor((surface.clientHeight - GRID_PAD * 2) / (ICON_H + GRID_GAP)));
  const col = Math.floor(index / cols);
  const row = index % cols;
  return {
    x: GRID_PAD + col * (ICON_W + GRID_GAP),
    y: GRID_PAD + row * (ICON_H + GRID_GAP)
  };
}

function renderDesktopIcons() {
  const surface = document.getElementById("desktop-surface");
  if (!surface) return;
  surface.innerHTML = "";
  const positions = loadIconPositions();
  let visibleIdx = 0;

  for (const app of availableApps()) {
    if (!app.desktop) continue;
    const icon = document.createElement("div");
    icon.className = "desk-icon";
    icon.dataset.appId = app.id;
    icon.innerHTML = `
      <div class="desk-icon-glyph">${escapeHtml(app.glyph)}</div>
      <div class="desk-icon-label">${escapeHtml(app.name)}</div>
    `;
    const pos = positions[app.id] || defaultPositionFor(visibleIdx);
    icon.style.left = pos.x + "px";
    icon.style.top  = pos.y + "px";
    visibleIdx++;

    icon.addEventListener("dblclick", () => launchApp(app.id));
    icon.addEventListener("click", (e) => {
      document.querySelectorAll(".desk-icon").forEach((d) => d.classList.remove("selected"));
      icon.classList.add("selected");
      e.stopPropagation();
    });
    icon.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAppContextMenu(e.clientX, e.clientY, app.id);
    });

    // Drag-and-drop with click vs drag distinction
    icon.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX, startY = e.clientY;
      const startL = parseInt(icon.style.left, 10);
      const startT = parseInt(icon.style.top, 10);
      let moved = false;

      function move(ev) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true;
        icon.classList.add("dragging");
        const sw = surface.clientWidth, sh = surface.clientHeight;
        const nx = Math.max(0, Math.min(sw - ICON_W,  startL + dx));
        const ny = Math.max(0, Math.min(sh - ICON_H,  startT + dy));
        icon.style.left = nx + "px";
        icon.style.top  = ny + "px";
      }
      function up() {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        icon.classList.remove("dragging");
        if (moved) {
          const map = loadIconPositions();
          map[app.id] = { x: parseInt(icon.style.left, 10), y: parseInt(icon.style.top, 10) };
          saveIconPositions(map);
        }
      }
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });

    surface.appendChild(icon);
  }
  surface.addEventListener("click", () => {
    document.querySelectorAll(".desk-icon").forEach((d) => d.classList.remove("selected"));
  });
}

function renderStartMenu() {
  const grid = document.getElementById("start-apps");
  if (!grid) return;
  grid.innerHTML = "";
  for (const app of availableApps()) {
    const item = document.createElement("div");
    item.className = "start-app";
    item.dataset.appId = app.id;
    item.dataset.name = app.name.toLowerCase();
    item.innerHTML = `
      <div class="start-app-glyph">${escapeHtml(app.glyph)}</div>
      <div class="start-app-label">${escapeHtml(app.name)}</div>
    `;
    item.addEventListener("click", () => launchApp(app.id));
    item.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAppContextMenu(e.clientX, e.clientY, app.id);
    });
    grid.appendChild(item);
  }
}

function renderTaskbarApps(wins) {
  currentWindows = wins || [];
  const bar = document.getElementById("taskbar-apps");
  if (!bar) return;
  bar.innerHTML = "";

  const runningAppIds = new Set(currentWindows.map((w) => w.appId || w.id));
  const pinned = loadPinned();

  // Pinned apps that are not currently running
  for (const id of pinned) {
    if (runningAppIds.has(id)) continue;
    const app = findApp(id);
    if (!app) continue;
    const btn = document.createElement("div");
    btn.className = "taskbar-app pinned";
    btn.innerHTML = `<span class="ta-glyph">${escapeHtml(app.glyph)}</span>`;
    btn.title = app.name + " (pinned)";
    btn.addEventListener("click", () => launchApp(app.id));
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showAppContextMenu(e.clientX, e.clientY, app.id);
    });
    bar.appendChild(btn);
  }

  // Running windows — one entry per window so multi-instance shows separately
  for (const w of currentWindows) {
    const btn = document.createElement("div");
    const active = !w.state.minimized && w.el.classList.contains("focused");
    const isPin = pinned.includes(w.appId || w.id);
    btn.className = "taskbar-app" + (active ? " active" : "") + (isPin ? " pinned" : "");
    btn.innerHTML = `<span class="ta-glyph">${escapeHtml(w.glyph)}</span><span>${escapeHtml(w.title)}</span>`;
    btn.title = w.title + (isPin ? " · pinned" : "");
    btn.addEventListener("click", () => toggleTaskbar(w.id));
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showAppContextMenu(e.clientX, e.clientY, w.appId || w.id);
    });
    bar.appendChild(btn);
  }
}

function findApp(id) {
  return availableApps().find((a) => a.id === id);
}

function showAppContextMenu(x, y, appId) {
  const items = [];
  items.push({
    label: isPinned(appId) ? "Unpin from taskbar" : "Pin to taskbar",
    action: () => togglePinned(appId)
  });
  items.push({ label: "Open", action: () => launchApp(appId) });
  showContextMenu(x, y, items);
}

function setupClock() {
  const el = document.getElementById("tray-clock");
  function tick() {
    const d = new Date();
    el.textContent = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) +
      " · " + d.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  tick();
  setInterval(tick, 30 * 1000);

  // Calendar popup
  const cal = document.getElementById("calendar");
  let viewYear, viewMonth;

  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!cal.classList.contains("hidden")) { cal.classList.add("hidden"); return; }
    const now = new Date();
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();
    renderCalendar();
    cal.classList.remove("hidden");
  });
  // Stop ALL click events inside the calendar from bubbling out — the inner
  // controls re-render the calendar (replacing innerHTML), which causes the
  // outside-click listener to see a "detached" target and close the popup.
  cal.addEventListener("mousedown", (e) => e.stopPropagation());
  cal.addEventListener("click",     (e) => e.stopPropagation());
  cal.addEventListener("change",    (e) => e.stopPropagation());
  document.addEventListener("click", (e) => {
    if (cal.classList.contains("hidden")) return;
    if (cal.contains(e.target) || e.target === el) return;
    cal.classList.add("hidden");
  });

  // Per-user calendar events stored in localStorage.
  function eventsKey() { return `blizzard.calendar.${currentUser?.uid || "guest"}`; }
  function loadEvents() {
    try { return JSON.parse(localStorage.getItem(eventsKey()) || "{}"); }
    catch { return {}; }
  }
  function saveEvents(map) { localStorage.setItem(eventsKey(), JSON.stringify(map)); }
  function eventsFor(y, m, d) {
    const key = `${y}-${m + 1}-${d}`;
    return loadEvents()[key] || [];
  }

  function renderCalendar() {
    const now = new Date();
    const monthName = new Date(viewYear, viewMonth, 1).toLocaleString([], { month: "long" });
    const firstDow = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrev  = new Date(viewYear, viewMonth, 0).getDate();
    const todayY = now.getFullYear(), todayM = now.getMonth(), todayD = now.getDate();
    const allEvents = loadEvents();

    const years = [];
    for (let y = 1900; y <= 2100; y++) years.push(y);

    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
      .map((d) => `<div class="calendar-dow">${d}</div>`).join("");

    function dayCell(y, m, d, dim) {
      const isToday = (y === todayY && m === todayM && d === todayD);
      const key = `${y}-${m + 1}-${d}`;
      const evs = allEvents[key] || [];
      const dot = evs.length ? `<span class="calendar-dot"></span>` : "";
      const cls = "calendar-day" + (dim ? " dim" : "") + (isToday ? " today" : "");
      return `<div class="${cls}" data-y="${y}" data-m="${m}" data-d="${d}">${d}${dot}</div>`;
    }

    const cells = [];
    for (let i = 0; i < firstDow; i++) {
      const d = daysInPrev - firstDow + i + 1;
      const py = viewMonth === 0 ? viewYear - 1 : viewYear;
      const pm = viewMonth === 0 ? 11 : viewMonth - 1;
      cells.push(dayCell(py, pm, d, true));
    }
    for (let d = 1; d <= daysInMonth; d++) cells.push(dayCell(viewYear, viewMonth, d, false));
    let after = 1;
    while (cells.length % 7 !== 0) {
      const ny = viewMonth === 11 ? viewYear + 1 : viewYear;
      const nm = viewMonth === 11 ? 0 : viewMonth + 1;
      cells.push(dayCell(ny, nm, after++, true));
    }

    cal.innerHTML = `
      <div class="calendar-now">
        <div class="calendar-now-time">${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>
        <div class="calendar-now-date">${now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>
      </div>
      <div class="calendar-header">
        <button data-act="prev" title="Previous month">‹</button>
        <span class="calendar-title">${monthName} ${viewYear}</span>
        <button data-act="next" title="Next month">›</button>
      </div>
      <div class="calendar-grid">${dow}${cells.join("")}</div>
      <div class="calendar-jump">
        <select data-bind="month">${["January","February","March","April","May","June","July","August","September","October","November","December"]
          .map((m, i) => `<option value="${i}"${i === viewMonth ? " selected" : ""}>${m}</option>`).join("")}</select>
        <select data-bind="year">${years.map((y) => `<option value="${y}"${y === viewYear ? " selected" : ""}>${y}</option>`).join("")}</select>
        <button data-act="today">Today</button>
      </div>
      <div class="calendar-events" data-bind="events"></div>
    `;
    cal.querySelector('[data-act="prev"]').onclick = (ev) => {
      ev.stopPropagation();
      viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      renderCalendar();
    };
    cal.querySelector('[data-act="next"]').onclick = (ev) => {
      ev.stopPropagation();
      viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      renderCalendar();
    };
    cal.querySelector('[data-act="today"]').onclick = (ev) => {
      ev.stopPropagation();
      viewYear = now.getFullYear(); viewMonth = now.getMonth(); renderCalendar();
    };
    cal.querySelector('[data-bind="month"]').onchange = (e) => { e.stopPropagation(); viewMonth = parseInt(e.target.value, 10); renderCalendar(); };
    cal.querySelector('[data-bind="year"]').onchange  = (e) => { e.stopPropagation(); viewYear  = parseInt(e.target.value, 10); renderCalendar(); };

    cal.querySelectorAll(".calendar-day[data-y]").forEach((dEl) =>
      dEl.addEventListener("click", (ev) => {
        ev.stopPropagation();
        showDayEvents(parseInt(dEl.dataset.y, 10), parseInt(dEl.dataset.m, 10), parseInt(dEl.dataset.d, 10));
      })
    );
  }

  function showDayEvents(y, m, d) {
    const eventsBox = cal.querySelector('[data-bind="events"]');
    if (!eventsBox) return;
    const key = `${y}-${m + 1}-${d}`;
    const all = loadEvents();
    const list = all[key] || [];
    const dateLabel = new Date(y, m, d).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    eventsBox.innerHTML = `
      <div class="calendar-events-head">${dateLabel}</div>
      <div class="calendar-events-list">
        ${list.length === 0
          ? `<div class="calendar-events-empty">No events. Add one below.</div>`
          : list.map((ev, i) => `
              <div class="calendar-event">
                <span>${escapeHtml(ev)}</span>
                <button data-rm="${i}" title="Remove">×</button>
              </div>
          `).join("")}
      </div>
      <div class="calendar-events-add">
        <input type="text" placeholder="Add event for this day…" data-bind="new-ev">
        <button data-act="add-ev">Add</button>
      </div>
    `;
    eventsBox.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const all = loadEvents();
        const arr = all[key] || [];
        arr.splice(parseInt(b.dataset.rm, 10), 1);
        if (arr.length === 0) delete all[key];
        else all[key] = arr;
        saveEvents(all);
        renderCalendar();
        showDayEvents(y, m, d);
      })
    );
    const newEv = eventsBox.querySelector('[data-bind="new-ev"]');
    const add = () => {
      const text = newEv.value.trim();
      if (!text) return;
      const all = loadEvents();
      if (!all[key]) all[key] = [];
      all[key].push(text);
      saveEvents(all);
      renderCalendar();
      showDayEvents(y, m, d);
    };
    eventsBox.querySelector('[data-act="add-ev"]').onclick = (e) => { e.stopPropagation(); add(); };
    newEv.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") add(); });
    setTimeout(() => newEv.focus(), 30);
  }
}

function setupTrayUser() {
  document.getElementById("tray-user").textContent = "@" + currentUser.username;
  document.getElementById("start-username").textContent = currentUser.username;
  renderStartAvatar();
  document.getElementById("start-signout").onclick = async () => {
    if (!confirm("Sign out of Blizzard?")) return;
    await flushDesktopLayout().catch(() => {});
    await doSignOut();
  };
}

function renderStartAvatar() {
  const el = document.getElementById("start-avatar");
  if (!el || !currentUser) return;
  const url = currentUser.profile?.avatarUrl;
  if (url) {
    el.style.backgroundImage = `url("${url.replace(/"/g, '\\"')}")`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
    el.style.color = "transparent";
    el.textContent = "";
  } else {
    el.style.backgroundImage = "";
    el.textContent = (currentUser.username[0] || "?").toUpperCase();
  }
}
document.addEventListener("blizzard:profile-changed", renderStartAvatar);

function setupStartButton() {
  const btn = document.getElementById("start-btn");
  const menu = document.getElementById("start-menu");

  function openStartMenu() {
    menu.classList.remove("hidden");
    const search = document.getElementById("start-search-input");
    search.value = "";
    filterStartApps("");
    search.focus();
  }

  function toggleStartMenu() {
    if (menu.classList.contains("hidden")) openStartMenu();
    else hideStartMenu();
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleStartMenu();
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== btn) hideStartMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideStartMenu();
    // Alt+A → open start menu (works on Chromebooks without a Windows key)
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === "a" || e.key === "A")) {
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return; // don't steal it from text fields
      e.preventDefault();
      toggleStartMenu();
    }
  });
  document.getElementById("start-search-input").addEventListener("input", (e) => {
    filterStartApps(e.target.value.toLowerCase());
  });
}

function filterStartApps(q) {
  document.querySelectorAll(".start-app").forEach((el) => {
    el.style.display = el.dataset.name.includes(q) ? "" : "none";
  });
}

function hideStartMenu() {
  document.getElementById("start-menu").classList.add("hidden");
}

function setupSearch() {
  const input = document.getElementById("search-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const q = input.value.trim();
      if (!q) return;
      const app = APPS.find((a) => a.name.toLowerCase().includes(q.toLowerCase()));
      if (app) {
        launchApp(app.id);
      } else {
        // route to Blizzard browser search
        openWindow({
          id: "browser",
          title: "Blizzard",
          glyph: "❄",
          width: 880, height: 560,
          render: ({ root, win }) =>
            getApp("browser").mount(root, { ...runtimeServices, user: currentUser, win, launchApp, initialQuery: q })
        });
      }
      input.value = "";
    }
  });
}

function setupContextMenus() {
  const menu = document.getElementById("context-menu");
  const surface = document.getElementById("desktop-surface");

  surface.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: "Open Files",            action: () => launchApp("files") },
      { label: "Open Terminal",         action: () => launchApp("terminal") },
      { label: "Open Blizzard Browser", action: () => launchApp("browser") },
      { sep: true },
      { label: "Settings",              action: () => launchApp("settings") }
    ]);
  });

  document.addEventListener("click", () => menu.classList.add("hidden"));
}

function showContextMenu(x, y, items) {
  const menu = document.getElementById("context-menu");
  menu.innerHTML = "";
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement("div");
      s.className = "context-menu-sep";
      menu.appendChild(s);
      continue;
    }
    const row = document.createElement("div");
    row.className = "context-menu-item";
    row.textContent = it.label;
    row.addEventListener("click", () => { menu.classList.add("hidden"); it.action(); });
    menu.appendChild(row);
  }
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  menu.classList.remove("hidden");
  // Clamp to viewport
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 8) + "px";
    if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 8) + "px";
  });
}
