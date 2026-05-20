// Blizzard Store. The catalog comes from Firebase apps/{id}; installing an app
// stores only a per-user reference under installed/{uid}.

import {
  listStoreApps, publishStoreApp,
  listInstalledApps, installApp, uninstallApp
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";

export async function mountStore(root, ctx) {
  root.innerHTML = `<div class="app"></div>`;
  await renderStorefront(root.firstElementChild, ctx);
}

// Used by the browser to render the store inside a tab (blizz://store).
export async function renderStorefront(host, ctx) {
  host.innerHTML = `
    <div class="app-toolbar">
      <input type="search" class="grow" placeholder="Search apps..." data-bind="q" />
      <button class="primary" data-act="publish">Publish an app</button>
      <button data-act="refresh" title="Refresh">Refresh</button>
    </div>
    <div class="community" style="flex:1;min-height:0">
      <div class="community-grid" data-bind="grid"></div>
    </div>
  `;

  const grid = host.querySelector('[data-bind="grid"]');
  const search = host.querySelector('[data-bind="q"]');
  let installed = await listInstalledApps(ctx.user.uid);
  let storeApps = await listStoreApps();

  async function refresh() {
    installed = await listInstalledApps(ctx.user.uid);
    storeApps = await listStoreApps();
    render();
  }

  function isInstalled(id) {
    return installed.some((app) => app.id === id);
  }

  function normalizeStoreApp(app) {
    const source = app.official || app.builtin ? "builtin" : "user";
    return {
      id: app.id,
      name: app.title || app.name || app.id,
      glyph: app.glyph || "App",
      description: app.description || "",
      code: app.code || "",
      builtin: app.builtin || null,
      official: !!app.official,
      authorUsername: app.authorUsername || "anon",
      source
    };
  }

  function render() {
    const q = (search.value || "").toLowerCase();
    const filtered = storeApps
      .map(normalizeStoreApp)
      .filter((app) =>
        !q ||
        app.name.toLowerCase().includes(q) ||
        app.description.toLowerCase().includes(q) ||
        app.authorUsername.toLowerCase().includes(q)
      );

    if (filtered.length === 0) {
      grid.innerHTML = `<div class="muted" style="grid-column:1/-1;padding:30px;text-align:center">No apps found.</div>`;
      return;
    }

    grid.innerHTML = filtered.map((app) => `
      <div class="game-card" data-id="${escapeHtml(app.id)}">
        <div class="game-card-thumb">${escapeHtml(app.glyph)}</div>
        <div class="game-card-body">
          <div class="game-card-title">${escapeHtml(app.name)}</div>
          <div class="game-card-author">by @${escapeHtml(app.authorUsername)}${app.official ? ' · <span class="pill">official</span>' : ""}</div>
          <div class="game-card-desc">${escapeHtml(app.description)}</div>
          <div class="game-card-footer">
            ${isInstalled(app.id)
              ? `<button data-act="open">Open</button><button class="danger" data-act="uninstall">Uninstall</button>`
              : `<button class="primary" data-act="install">Install</button>`}
          </div>
        </div>
      </div>
    `).join("");

    grid.querySelectorAll(".game-card").forEach((card) => {
      const app = filtered.find((item) => item.id === card.dataset.id);
      if (!app) return;

      const installBtn = card.querySelector('[data-act="install"]');
      const uninstallBtn = card.querySelector('[data-act="uninstall"]');
      const openBtn = card.querySelector('[data-act="open"]');

      if (installBtn) installBtn.onclick = async () => {
        await installApp(ctx.user.uid, {
          id: app.id,
          name: app.name,
          glyph: app.glyph,
          description: app.description,
          builtin: app.builtin,
          source: app.source
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

      if (openBtn) openBtn.onclick = () => openInstalledApp(app);
    });
  }

  function openInstalledApp(app) {
    if (ctx.launchApp) {
      ctx.launchApp(app.builtin || app.id);
      return;
    }

    const popup = window.open("", "_blank", "width=900,height=640");
    if (!popup) {
      alert("Pop-up blocked. Allow pop-ups for this site.");
      return;
    }
    popup.document.write(app.code || "<!doctype html><body><h1>Empty app</h1></body>");
  }

  host.querySelector('[data-act="refresh"]').addEventListener("click", refresh);
  host.querySelector('[data-act="publish"]').addEventListener("click", () => openPublishDialog(ctx, refresh));
  search.addEventListener("input", render);

  render();
}

function openPublishDialog(ctx, onDone) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(5,9,18,0.7);z-index:5000;display:flex;align-items:center;justify-content:center";
  overlay.innerHTML = `
    <div style="width:560px;max-width:92vw;background:var(--bg-1);border:1px solid var(--line-strong);border-radius:10px;padding:18px;box-shadow:var(--shadow-2);user-select:text">
      <h3 style="margin:0 0 12px;font-weight:500">Publish an app</h3>
      <div class="col" style="gap:10px">
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">App name</span>
          <input id="sa-name" type="text" style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none"></label>
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Icon text</span>
          <input id="sa-glyph" type="text" maxlength="6" placeholder="App" style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none;width:90px"></label>
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
    const glyph = overlay.querySelector("#sa-glyph").value.trim() || "App";
    const code = overlay.querySelector("#sa-code").value.trim() || "<!doctype html><body><h1>Hello</h1></body>";
    if (!title) {
      alert("Title is required.");
      return;
    }

    await publishStoreApp(ctx.user.uid, ctx.user.username, { title, description, glyph, code });
    overlay.remove();
    onDone();
  };
}
