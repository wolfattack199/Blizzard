// Settings — profile, appearance, about, danger zone.
import { auth, signOut, listUsers } from "../firebase.js";
import * as FS from "../fs.js";
import { escapeHtml } from "../os/wm.js";
import { getAppearance, setAppearance, applyAppearance, APPEARANCE_PRESETS } from "../os/appearance.js";

export async function mountSettings(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="settings">
        <div class="settings-nav">
          <div class="settings-nav-item active" data-tab="account">Account</div>
          <div class="settings-nav-item" data-tab="appearance">Appearance</div>
          <div class="settings-nav-item" data-tab="users">Users</div>
          <div class="settings-nav-item" data-tab="storage">Storage</div>
          <div class="settings-nav-item" data-tab="about">About</div>
        </div>
        <div class="settings-content" data-bind="content"></div>
      </div>
    </div>
  `;

  const content = root.querySelector('[data-bind="content"]');
  const tabs = root.querySelectorAll(".settings-nav-item");

  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.toggle("active", x === t));
      renderTab(t.dataset.tab);
    })
  );

  function renderTab(tab) {
    if (tab === "account") {
      content.innerHTML = `
        <h2>Account</h2>
        <div class="settings-row">
          <label>Username</label>
          <span>@${escapeHtml(ctx.user.username)}</span>
        </div>
        <div class="settings-row">
          <label>User ID</label>
          <span class="muted" style="font-family: var(--mono); font-size: 11px;">${escapeHtml(ctx.user.uid)}</span>
        </div>
        <div class="settings-row">
          <label>Signed in</label>
          <button class="danger" data-act="signout">Sign out</button>
        </div>
      `;
      content.querySelector('[data-act="signout"]').onclick = async () => {
        if (!confirm("Sign out of Blizzard OS?")) return;
        await window.bzFlushDesktopLayout?.().catch(() => {});
        await signOut(auth);
      };
    } else if (tab === "appearance") {
      const cur = getAppearance();
      content.innerHTML = `
        <h2>Appearance</h2>
        <div class="settings-row">
          <label>Preset wallpaper</label>
          <div class="row" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
            ${APPEARANCE_PRESETS.map((p, i) => `
              <button data-act="preset" data-idx="${i}"
                style="width:64px;height:40px;border-radius:6px;background:${p.thumb};${cur.preset === i && cur.kind === 'preset' ? 'border:2px solid var(--accent);' : ''}padding:0"></button>
            `).join("")}
          </div>
        </div>
        <div class="settings-row">
          <label>Solid color</label>
          <input type="color" data-bind="solid" value="${cur.solid || '#0b1220'}"
            style="width:60px;height:32px;border:1px solid var(--line);background:transparent;cursor:pointer">
        </div>
        <div class="settings-row">
          <label>Background image URL</label>
          <input type="text" data-bind="img" value="${escapeHtml(cur.imageUrl || '')}" placeholder="https://…/wallpaper.jpg"
            style="flex:1;max-width:340px;padding:6px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none">
        </div>
        <div class="settings-row">
          <label>Upload from this device</label>
          <input type="file" accept="image/*" data-bind="upload" style="font-size:11.5px;color:var(--text-1)">
        </div>
        <div class="settings-row">
          <label>Accent color</label>
          <input type="color" data-bind="accent" value="${cur.accent || '#5aa9ff'}"
            style="width:60px;height:32px;border:1px solid var(--line);background:transparent;cursor:pointer">
        </div>
        <div class="settings-row">
          <label>Reset to defaults</label>
          <button data-act="reset">Reset</button>
        </div>
      `;

      content.querySelectorAll('[data-act="preset"]').forEach((b) =>
        b.addEventListener("click", () => {
          setAppearance({ ...getAppearance(), kind: "preset", preset: parseInt(b.dataset.idx, 10), imageUrl: "" });
          renderTab("appearance");
        })
      );
      content.querySelector('[data-bind="solid"]').addEventListener("change", (e) => {
        setAppearance({ ...getAppearance(), kind: "solid", solid: e.target.value, imageUrl: "" });
      });
      content.querySelector('[data-bind="img"]').addEventListener("change", (e) => {
        const url = e.target.value.trim();
        setAppearance({ ...getAppearance(), kind: url ? "image" : "preset", imageUrl: url });
      });
      content.querySelector('[data-bind="upload"]').addEventListener("change", (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          setAppearance({ ...getAppearance(), kind: "image", imageUrl: r.result });
        };
        r.readAsDataURL(f);
      });
      content.querySelector('[data-bind="accent"]').addEventListener("change", (e) => {
        setAppearance({ ...getAppearance(), accent: e.target.value });
      });
      content.querySelector('[data-act="reset"]').onclick = () => {
        setAppearance({ kind: "preset", preset: 0, solid: "#0b1220", imageUrl: "", accent: "#5aa9ff" });
        renderTab("appearance");
      };
    } else if (tab === "users") {
      content.innerHTML = `<h2>Users</h2><div data-bind="users-list">Loading…</div>`;
      listUsers().then((users) => {
        const target = content.querySelector('[data-bind="users-list"]');
        if (!target) return;
        target.innerHTML = users.length === 0
          ? `<div class="muted">No registered users yet.</div>`
          : users.map((u) => `
              <div class="settings-row">
                <div>
                  <div>@${escapeHtml(u.username)}${u.uid === ctx.user.uid ? ' <span class="pill">you</span>' : ""}</div>
                  <div class="muted" style="font-size: 11px;">${u.createdAt ? new Date(u.createdAt).toLocaleString() : ""}</div>
                </div>
              </div>
            `).join("");
      });
    } else if (tab === "storage") {
      content.innerHTML = `<h2>Storage</h2><div data-bind="storage-info">Calculating…</div>
        <div class="settings-row" style="margin-top: 20px;">
          <label style="color: var(--danger);">Erase local data</label>
          <button class="danger" data-act="erase">Erase this device</button>
        </div>
        <div class="muted" style="font-size: 12px; margin-top: 6px;">
          Removes downloaded apps, documents, and projects on this device. Your Blizzard account and published sites are kept.
        </div>`;
      computeStorage().then((info) => {
        const target = content.querySelector('[data-bind="storage-info"]');
        if (target) target.innerHTML = `
          <div class="settings-row"><label>Files</label><span>${info.count}</span></div>
          <div class="settings-row"><label>Approx size</label><span>${(info.bytes / 1024).toFixed(1)} KB</span></div>
        `;
      });
      content.querySelector('[data-act="erase"]').onclick = async () => {
        if (!confirm("Erase ALL local files on this device? This cannot be undone.")) return;
        const all = await FS.list("/", { recursive: true, includeHidden: true });
        for (const f of all) await FS.remove(f.path);
        alert("Local data erased. Reloading.");
        location.reload();
      };
    } else if (tab === "about") {
      content.innerHTML = `
        <h2>About Blizzard OS</h2>
        <p class="muted">A simulated browser-based operating system with its own internal web ecosystem.</p>
        <div class="settings-row"><label>Version</label><span>1.0.0</span></div>
        <div class="settings-row"><label>Frontend</label><span>HTML / CSS / JS / JSON</span></div>
        <div class="settings-row"><label>Backend</label><span>Firebase (Auth + Realtime Database)</span></div>
        <div class="settings-row"><label>Local storage</label><span>IndexedDB</span></div>
        <p class="muted" style="margin-top: 20px; font-size: 12px;">
          Inspired by NautilusOS. Built for learning and play. No proxies — all websites
          in the Blizzard ecosystem are authored inside the OS itself.
        </p>
      `;
    }
  }

  renderTab("account");
}

async function computeStorage() {
  const items = await FS.list("/", { recursive: true, includeHidden: true });
  let bytes = 0;
  for (const it of items) bytes += (it.content || "").length;
  return { count: items.length, bytes };
}
