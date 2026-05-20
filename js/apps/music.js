// Music — local audio player. Loads .mp3/.wav files from the user's FS
// (stored as data URLs) or via drag-and-drop from the host filesystem.

import * as FS from "../fs.js";

const TRACKS_DIR = "/Music";

export async function mountMusic(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="app-toolbar">
        <input type="file" id="m-file" accept="audio/*" multiple style="display:none">
        <button class="primary" data-act="add">＋ Add tracks</button>
        <button data-act="refresh">⟳</button>
      </div>
      <div class="music">
        <div class="music-dropzone" data-bind="drop">Drop audio files here, or click "Add tracks".</div>
        <div class="music-list" data-bind="list"></div>
        <div class="music-player">
          <div data-bind="now-playing" style="min-width:180px;font-size:12.5px;color:var(--text-1)">Nothing playing</div>
          <audio controls data-bind="audio"></audio>
        </div>
      </div>
    </div>
  `;

  const list  = root.querySelector('[data-bind="list"]');
  const audio = root.querySelector('[data-bind="audio"]');
  const np    = root.querySelector('[data-bind="now-playing"]');
  const drop  = root.querySelector('[data-bind="drop"]');
  const fileInput = root.querySelector("#m-file");

  if (!(await FS.exists(TRACKS_DIR))) await FS.mkdir(TRACKS_DIR);

  async function refresh() {
    const tracks = (await FS.list(TRACKS_DIR)).filter((f) => !f.isDir);
    if (tracks.length === 0) {
      list.innerHTML = `<div class="muted" style="padding:30px;text-align:center">No tracks yet. Drop some audio files in.</div>`;
      return;
    }
    list.innerHTML = tracks.map((t) => `
      <div class="music-track" data-path="${t.path}">
        <span>🎵 ${escapeHtml(t.name)}</span>
        <button class="danger" data-act="del" data-path="${t.path}" style="padding:2px 8px;font-size:11px">Delete</button>
      </div>
    `).join("");
    list.querySelectorAll(".music-track").forEach((el) =>
      el.addEventListener("click", (e) => {
        if (e.target.closest('[data-act="del"]')) return;
        play(el.dataset.path);
      })
    );
    list.querySelectorAll('[data-act="del"]').forEach((b) =>
      b.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (confirm("Delete this track?")) { await FS.remove(b.dataset.path); refresh(); }
      })
    );
  }

  async function play(path) {
    const rec = await FS.read(path);
    if (!rec) return;
    audio.src = rec.content; // stored as data: URL
    audio.play().catch(() => {});
    np.textContent = "▶ " + path.split("/").pop();
    list.querySelectorAll(".music-track").forEach((el) => el.classList.toggle("playing", el.dataset.path === path));
  }

  async function addFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith("audio/")) continue;
      const dataUrl = await readAsDataURL(f);
      const safe = f.name.replace(/[^a-zA-Z0-9._ -]/g, "");
      await FS.write(TRACKS_DIR + "/" + safe, dataUrl, { type: "text" });
    }
    refresh();
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  root.querySelector('[data-act="add"]').onclick = () => fileInput.click();
  root.querySelector('[data-act="refresh"]').onclick = refresh;
  fileInput.addEventListener("change", () => addFiles([...fileInput.files]));

  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.style.borderColor = "var(--accent)"; });
  drop.addEventListener("dragleave", () => { drop.style.borderColor = ""; });
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.style.borderColor = ""; addFiles([...e.dataTransfer.files]); });
  drop.addEventListener("click", () => fileInput.click());

  await refresh();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[c]));
}
