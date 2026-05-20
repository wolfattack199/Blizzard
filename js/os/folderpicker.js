// A simple folder picker dialog backed by the FS module. Resolves to the
// chosen path (string) or null on cancel.
import * as FS from "../fs.js";
import { escapeHtml } from "./wm.js";

const SHORTCUTS = [
  { label: "Home",         path: "/" },
  { label: "Cloud — My Files", path: FS.CLOUD_MINE },
  { label: "Documents",    path: "/Documents" },
  { label: "Projects",     path: "/Projects" },
  { label: "Downloads",    path: "/Downloads" },
  { label: "Pictures",     path: "/Pictures" }
];

export async function pickFolder({ title = "Open folder", initialPath = "/" } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(5,9,18,0.7);z-index:7500;display:flex;align-items:center;justify-content:center`;
    overlay.innerHTML = `
      <div class="fp-modal">
        <div class="fp-head">
          <div style="font-weight:600">${escapeHtml(title)}</div>
          <span class="grow" style="flex:1"></span>
          <button data-act="cancel" style="padding:3px 10px;font-size:12px">Cancel</button>
        </div>
        <div class="fp-body">
          <div class="fp-side" data-bind="side"></div>
          <div class="fp-main">
            <div class="fp-path" data-bind="path"></div>
            <div class="fp-list" data-bind="list">Loading…</div>
          </div>
        </div>
        <div class="fp-foot">
          <button data-act="new-folder">＋ New folder</button>
          <span class="grow" style="flex:1"></span>
          <button class="primary" data-act="open">Open this folder</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let cwd = FS.normalize(initialPath || "/");

    const sideEl = overlay.querySelector('[data-bind="side"]');
    const pathEl = overlay.querySelector('[data-bind="path"]');
    const listEl = overlay.querySelector('[data-bind="list"]');

    function renderSide() {
      sideEl.innerHTML = SHORTCUTS.map((s) => `
        <div class="fp-shortcut${s.path === cwd ? " active" : ""}" data-path="${escapeHtml(s.path)}">${escapeHtml(s.label)}</div>
      `).join("");
      sideEl.querySelectorAll(".fp-shortcut").forEach((el) =>
        el.addEventListener("click", () => { cwd = el.dataset.path; render(); })
      );
    }

    async function render() {
      pathEl.textContent = cwd;
      renderSide();
      let items;
      try { items = await FS.list(cwd); }
      catch (e) { listEl.innerHTML = `<div class="muted" style="padding:14px">Can't read: ${escapeHtml(e.message)}</div>`; return; }
      const folders = items.filter((i) => i.isDir);
      if (folders.length === 0) {
        listEl.innerHTML = `<div class="muted" style="padding:14px">No subfolders here. Click "Open this folder" to pick the current one.</div>`;
        return;
      }
      listEl.innerHTML = folders.map((f) => `
        <div class="fp-folder" data-path="${escapeHtml(f.path)}">
          <span style="font-size:18px">📁</span>
          <span>${escapeHtml(f.name)}</span>
        </div>
      `).join("");
      listEl.querySelectorAll(".fp-folder").forEach((el) =>
        el.addEventListener("dblclick", () => { cwd = el.dataset.path; render(); })
      );
      listEl.querySelectorAll(".fp-folder").forEach((el) =>
        el.addEventListener("click", () => {
          listEl.querySelectorAll(".fp-folder").forEach((d) => d.classList.remove("selected"));
          el.classList.add("selected");
        })
      );
    }

    overlay.querySelector('[data-act="cancel"]').onclick = () => { overlay.remove(); resolve(null); };
    overlay.querySelector('[data-act="open"]').onclick = () => {
      const sel = listEl.querySelector(".fp-folder.selected");
      const path = sel ? sel.dataset.path : cwd;
      overlay.remove(); resolve(path);
    };
    overlay.querySelector('[data-act="new-folder"]').onclick = async () => {
      const name = prompt("Folder name?");
      if (!name) return;
      const newPath = cwd === "/" ? "/" + name : cwd + "/" + name;
      try {
        await FS.mkdir(newPath);
        cwd = newPath;
        render();
      } catch (e) {
        alert("Couldn't create folder: " + e.message);
      }
    };

    render();
  });
}
