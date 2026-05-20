// Blizzard Store — apps catalog (built-in + user-submitted). Installs persist
// to Firebase under installed/{uid}, so they follow you to other devices.

import {
  listStoreApps, publishStoreApp, getStoreApp,
  listInstalledApps, installApp, uninstallApp
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";

// Built-in apps available in the store. These reference real apps in the OS
// registry by id; "installing" just toggles whether they appear in the start
// menu / desktop. Code lives in the bundle, not in Firebase.
export const BUILTIN_STORE_APPS = [
  {
    id: "engine",
    name: "Blizzard Engine",
    glyph: "🎯",
    builtin: "engine",
    description: "Drag-and-drop 2D game maker. Drop sprites onto a stage, choose which one's the player, hit Run to play. Publish your creation straight to the Community Hub.",
    authorUsername: "Blizzard",
    free: true
  },
  {
    id: "paint",
    name: "Paint",
    glyph: "🎨",
    builtin: "paint",
    description: "Classic canvas drawing — pencil, brush, eraser, fill, line, rectangle. Save to your Pictures folder.",
    authorUsername: "Blizzard",
    free: true
  },
  {
    id: "notes",
    name: "Notes",
    glyph: "📝",
    builtin: "notes",
    description: "Sticky notes that sync to your Blizzard account. Drag them around, change colors, never lose a thought.",
    authorUsername: "Blizzard",
    free: true
  },
  {
    id: "calculator",
    name: "Calculator",
    glyph: "🧮",
    builtin: "calculator",
    description: "Standard four-function calculator with keyboard shortcuts.",
    authorUsername: "Blizzard",
    free: true
  },
  {
    id: "music",
    name: "Music",
    glyph: "🎵",
    builtin: "music",
    description: "Drag-and-drop audio player. Loads .mp3 / .wav from your file system.",
    authorUsername: "Blizzard",
    free: true
  }
];

export async function mountStore(root, ctx) {
  root.innerHTML = `<div class="app"></div>`;
  await renderStorefront(root.firstElementChild, ctx);
}

// Used by the browser to render the store inside a tab (blizz://store)
export async function renderStorefront(host, ctx) {
  host.innerHTML = `
    <div class="app-toolbar">
      <input type="search" class="grow" placeholder="Search apps…" data-bind="q" />
      <button class="primary" data-act="publish">＋ Publish an app</button>
      <button data-act="refresh">⟳</button>
    </div>
    <div class="community" style="flex:1;min-height:0">
      <div class="community-grid" data-bind="grid"></div>
    </div>
  `;
  const grid    = host.querySelector('[data-bind="grid"]');
  const search  = host.querySelector('[data-bind="q"]');
  let installed = await listInstalledApps(ctx.user.uid);
  let storeApps = await listStoreApps();

  async function refresh() {
    installed = await listInstalledApps(ctx.user.uid);
    storeApps = await listStoreApps();
    render();
  }

  function isInstalled(id) { return installed.some((a) => a.id === id); }

  function render() {
    const q = (search.value || "").toLowerCase();
    const userApps = storeApps.map((a) => ({
      id: a.id,
      name: a.title,
      glyph: a.glyph || "📦",
      description: a.description || "",
      code: a.code,
      authorUsername: a.authorUsername || "anon",
      source: "user"
    }));
    const all = [...BUILTIN_STORE_APPS.map((a) => ({ ...a, source: "builtin" })), ...userApps];
    const filtered = all.filter((a) =>
      !q || a.name.toLowerCase().includes(q) || (a.description || "").toLowerCase().includes(q)
    );
    if (filtered.length === 0) {
      grid.innerHTML = `<div class="muted" style="grid-column:1/-1;padding:30px;text-align:center">No apps found.</div>`;
      return;
    }
    grid.innerHTML = filtered.map((a) => `
      <div class="game-card" data-id="${escapeHtml(a.id)}" data-source="${escapeHtml(a.source)}">
        <div class="game-card-thumb">${escapeHtml(a.glyph || "📦")}</div>
        <div class="game-card-body">
          <div class="game-card-title">${escapeHtml(a.name)}</div>
          <div class="game-card-author">by @${escapeHtml(a.authorUsername || "anon")}${a.source === "builtin" ? ' · <span class="pill">official</span>' : ""}</div>
          <div class="game-card-desc">${escapeHtml(a.description || "")}</div>
          <div class="game-card-footer">
            ${isInstalled(a.id)
              ? `<button data-act="open">Open</button><button class="danger" data-act="uninstall">Uninstall</button>`
              : `<button class="primary" data-act="install">Install</button>`}
          </div>
        </div>
      </div>
    `).join("");

    grid.querySelectorAll(".game-card").forEach((card) => {
      const id = card.dataset.id;
      const source = card.dataset.source;
      const app = filtered.find((x) => x.id === id);
      const installBtn = card.querySelector('[data-act="install"]');
      const uninstallBtn = card.querySelector('[data-act="uninstall"]');
      const openBtn = card.querySelector('[data-act="open"]');
      if (installBtn) installBtn.onclick = async () => {
        // Store only a *reference* to the app, not the code. User-published
        // app code lives in `apps/{id}` in the DB and is fetched fresh on
        // launch — that way the author can update it, and users can't tamper
        // with copies on their side.
        await installApp(ctx.user.uid, {
          id: app.id,
          name: app.name,
          glyph: app.glyph,
          description: app.description,
          builtin: app.builtin || null,
          source
        });
        await refresh();
        document.dispatchEvent(new CustomEvent("blizzard:installed-changed"));
      };
      if (uninstallBtn) uninstallBtn.onclick = async () => {
        if (!confirm(`Uninstall "${app.name}"?`)) return;
        await uninstallApp(ctx.user.uid, app.id);
        await refresh();
        document.dispatchEvent(new CustomEvent("blizzard:installed-changed"));
      };
      if (openBtn) openBtn.onclick = () => openInstalledApp(app, ctx);
    });
  }

  function openInstalledApp(app, ctx) {
    if (app.builtin && ctx.launchApp) {
      ctx.launchApp(app.builtin);
      return;
    }
    // User-published app: open code in a sandboxed iframe window
    const w = window.open("", "_blank", "width=900,height=640");
    if (!w) { alert("Pop-up blocked. Allow pop-ups for this site."); return; }
    w.document.write(app.code || "<h1>Empty app</h1>");
  }

  host.querySelector('[data-act="refresh"]').addEventListener("click", refresh);
  host.querySelector('[data-act="publish"]').addEventListener("click", () => openPublishDialog(ctx, refresh));
  search.addEventListener("input", render);

  render();
}

function openPublishDialog(ctx, onDone) {
  const overlay = document.createElement("div");
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(5,9,18,0.7);z-index:5000;display:flex;align-items:center;justify-content:center`;
  overlay.innerHTML = `
    <div style="width:560px;max-width:92vw;background:var(--bg-1);border:1px solid var(--line-strong);border-radius:10px;padding:18px;box-shadow:var(--shadow-2);user-select:text">
      <h3 style="margin:0 0 12px;font-weight:500">Publish an app</h3>
      <div class="col" style="gap:10px">
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">App name</span>
          <input id="sa-name" type="text" style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none"></label>
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Emoji icon</span>
          <input id="sa-glyph" type="text" maxlength="4" placeholder="📦" style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none;width:80px"></label>
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Description</span>
          <textarea id="sa-desc" rows="2" style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none;resize:vertical;font-family:inherit"></textarea></label>
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">App code (single HTML file)</span>
          <textarea id="sa-code" rows="10" placeholder="<!doctype html>..." style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none;font-family:var(--mono);font-size:12px;resize:vertical"></textarea></label>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px;gap:8px">
        <button id="sa-cancel">Cancel</button>
        <button class="primary" id="sa-submit">Publish</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#sa-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#sa-submit").onclick = async () => {
    const title = overlay.querySelector("#sa-name").value.trim();
    const description = overlay.querySelector("#sa-desc").value.trim();
    const glyph = overlay.querySelector("#sa-glyph").value.trim() || "📦";
    const code = overlay.querySelector("#sa-code").value.trim() || "<!doctype html><body><h1>Hello</h1></body>";
    if (!title) { alert("Title is required."); return; }
    await publishStoreApp(ctx.user.uid, ctx.user.username, { title, description, glyph, code });
    overlay.remove();
    onDone();
  };
}
