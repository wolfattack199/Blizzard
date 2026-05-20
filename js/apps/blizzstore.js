// Blizz Web Store — extension store accessed via blizz://blizzstore.com /
// blizz://blizzstore.blz. The /dev path opens the developer publish UI.
//
// Extensions are JS code blobs that get injected into Blizzard sites by the
// browser when the user has them installed + enabled.

import {
  listExtensions, publishExtension, deleteExtension,
  subscribeMyExtensions, installExtension, uninstallExtension, setExtensionEnabled
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";

export async function renderBlizzStore(host, ctx, route) {
  const isDev = (route?.path || "").replace(/^\/+/, "").toLowerCase().startsWith("dev");
  host.innerHTML = `
    <div class="blizzstore">
      <div class="blizzstore-top">
        <div style="display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px">
          <span style="font-size:20px">🧩</span><span>Blizz Web Store</span>
        </div>
        <span class="grow" style="flex:1"></span>
        ${isDev
          ? `<a class="blizzstore-tab" data-nav="">← Back to store</a>`
          : `<a class="blizzstore-tab" data-nav="/dev">Developer →</a>`}
      </div>
      <div class="blizzstore-body" data-bind="body">Loading…</div>
    </div>
  `;
  host.querySelectorAll("[data-nav]").forEach((a) =>
    a.addEventListener("click", () => {
      const targetPath = a.dataset.nav;
      // Update the parent browser by dispatching the existing open-tab event.
      // Simpler: call host.__bzNav if available, else fall back to alert.
      if (host.__bzNav) host.__bzNav(`blizzstore.com${targetPath ? "/" + targetPath : ""}`);
    })
  );

  if (isDev) renderDeveloper(host, ctx);
  else renderStore(host, ctx);
}

async function renderStore(host, ctx) {
  const body = host.querySelector('[data-bind="body"]');
  body.innerHTML = `<div class="muted" style="padding:30px;text-align:center">Loading extensions…</div>`;

  const [all, installed] = await Promise.all([
    listExtensions(),
    new Promise((resolve) => {
      const unsub = subscribeMyExtensions(ctx.user.uid, (list) => { unsub(); resolve(list); });
    })
  ]);
  const installedIds = new Set(installed.map((e) => e.id));

  if (all.length === 0) {
    body.innerHTML = `
      <div class="blizzstore-empty">
        <div style="font-size:48px;opacity:0.5">🧩</div>
        <div style="font-size:16px;font-weight:600;margin-top:8px">No extensions yet.</div>
        <div class="muted" style="margin-top:4px">Be the first — go to <a class="blizzstore-tab" data-nav="/dev">Developer</a>.</div>
      </div>
    `;
    body.querySelectorAll("[data-nav]").forEach((a) =>
      a.addEventListener("click", () => host.__bzNav?.(`blizzstore.com${a.dataset.nav}`))
    );
    return;
  }

  body.innerHTML = `
    <div class="blizzstore-grid">
      ${all.map((ext) => `
        <div class="blizzstore-card" data-id="${escapeHtml(ext.id)}">
          <div class="blizzstore-card-glyph">${escapeHtml(ext.glyph || "🧩")}</div>
          <div class="blizzstore-card-info">
            <div class="blizzstore-card-name">${escapeHtml(ext.name)}</div>
            <div class="blizzstore-card-author">by @${escapeHtml(ext.authorUsername || "anon")} · ${ext.installs || 0} installs</div>
            <div class="blizzstore-card-desc">${escapeHtml(ext.description || "")}</div>
            <div class="blizzstore-card-actions">
              ${installedIds.has(ext.id)
                ? `<button class="danger" data-act="uninstall">Uninstall</button>`
                : `<button class="primary" data-act="install">+ Install</button>`}
            </div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
  body.querySelectorAll(".blizzstore-card").forEach((card) => {
    const id = card.dataset.id;
    const ext = all.find((e) => e.id === id);
    const installBtn = card.querySelector('[data-act="install"]');
    const uninstallBtn = card.querySelector('[data-act="uninstall"]');
    if (installBtn) installBtn.onclick = async () => {
      await installExtension(ctx.user.uid, ext);
      renderStore(host, ctx);
    };
    if (uninstallBtn) uninstallBtn.onclick = async () => {
      if (!confirm(`Uninstall "${ext.name}"?`)) return;
      await uninstallExtension(ctx.user.uid, id);
      renderStore(host, ctx);
    };
  });
}

async function renderDeveloper(host, ctx) {
  const body = host.querySelector('[data-bind="body"]');
  body.innerHTML = `
    <div class="blizzstore-dev">
      <h3 style="margin:0 0 6px;font-weight:600">Publish an extension</h3>
      <p class="muted" style="font-size:12.5px;margin:0 0 14px">
        Extensions are JS that runs inside Blizzard sites in the browser. Use plain JavaScript;
        no <code>import</code> statements. <code>window.bz</code> is available for site APIs.
      </p>
      <div class="col" style="gap:10px;max-width:640px">
        <label class="col" style="gap:4px">
          <span class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Name</span>
          <input id="ext-name" type="text"
            style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none">
        </label>
        <label class="col" style="gap:4px">
          <span class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Emoji icon</span>
          <input id="ext-glyph" type="text" maxlength="4" placeholder="🧩"
            style="padding:8px 10px;width:80px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none">
        </label>
        <label class="col" style="gap:4px">
          <span class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Description</span>
          <textarea id="ext-desc" rows="2"
            style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none;resize:vertical;font-family:inherit"></textarea>
        </label>
        <label class="col" style="gap:4px">
          <span class="muted" style="font-size:11px;letter-spacing:0.5px;text-transform:uppercase">Code (runs in each Blizzard site)</span>
          <textarea id="ext-code" rows="14" placeholder="// Example: tint every site in dark mode
document.body.style.filter = 'invert(0.9) hue-rotate(180deg)';"
            style="padding:10px;background:#0a0e18;color:#c8d4eb;border:1px solid var(--line);border-radius:5px;outline:none;resize:vertical;font-family:var(--mono);font-size:12.5px"></textarea>
        </label>
        <div class="row" style="justify-content:flex-end;margin-top:6px;gap:8px">
          <button data-act="cancel">Cancel</button>
          <button class="primary" data-act="publish">Publish</button>
        </div>
      </div>
      <hr style="border:none;border-top:1px solid var(--line);margin:20px 0">
      <h4 style="margin:0 0 8px;font-weight:600">Your published extensions</h4>
      <div data-bind="mine" class="muted" style="font-size:12.5px">Loading…</div>
    </div>
  `;
  body.querySelector('[data-act="cancel"]').onclick = () => host.__bzNav?.("blizzstore.com");
  body.querySelector('[data-act="publish"]').onclick = async () => {
    const name = body.querySelector("#ext-name").value.trim();
    const description = body.querySelector("#ext-desc").value.trim();
    const code = body.querySelector("#ext-code").value;
    const glyph = body.querySelector("#ext-glyph").value.trim() || "🧩";
    if (!name) { alert("Name is required."); return; }
    if (!code.trim()) { alert("Code is required."); return; }
    await publishExtension(ctx.user.uid, ctx.user.username, { name, description, code, glyph });
    alert("Published. Visit blizz://blizzstore.com to see it.");
    host.__bzNav?.("blizzstore.com");
  };

  // Show your own published extensions
  const all = await listExtensions();
  const mine = all.filter((e) => e.authorUid === ctx.user.uid);
  const mineEl = body.querySelector('[data-bind="mine"]');
  if (mine.length === 0) mineEl.textContent = "You haven't published any extensions yet.";
  else {
    mineEl.innerHTML = mine.map((e) => `
      <div style="display:flex;gap:8px;align-items:center;padding:6px 8px;background:var(--bg-2);border-radius:4px;margin-bottom:4px">
        <span style="font-size:18px">${escapeHtml(e.glyph || "🧩")}</span>
        <span style="flex:1;color:var(--text-0)">${escapeHtml(e.name)} <span class="muted">· ${e.installs || 0} installs</span></span>
        <button class="danger" data-rm="${escapeHtml(e.id)}" style="padding:2px 8px;font-size:11px">Delete</button>
      </div>
    `).join("");
    mineEl.querySelectorAll("[data-rm]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Delete this extension? Installed users won't be able to update it.")) return;
        await deleteExtension(b.dataset.rm);
        renderDeveloper(host, ctx);
      })
    );
  }
}
