// Music — Spotify-like for songs + podcasts. Tracks are uploaded
// by users; everyone can browse. Each track is an audio blob in Firebase.
// Available as a desktop app AND as blizz://tunes inside the browser.

import {
  subscribeTunes, publishTune, getTuneBlob, deleteTune, incrementTunePlays,
  listPlaylists, createPlaylist, updatePlaylist, deletePlaylist,
  TUNE_MAX_BYTES, TUNE_ACCEPTED_EXTS
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";
import { resizeImageToDataURL } from "../os/avatar.js";

export async function mountTunes(root, ctx) {
  root.innerHTML = `<div class="app"></div>`;
  await renderTunes(root.firstElementChild, ctx);
}
// Used by the browser to render Tunes inside a tab (blizz://tunes)
export async function renderTunes(host, ctx) {
  host.innerHTML = `
    <div class="tunes">
      <div class="tunes-side">
        <div class="tunes-brand">
          <span style="font-size:22px">🎶</span>
          <span style="font-weight:600;letter-spacing:0.5px">Music</span>
        </div>
        <div class="tunes-nav">
          <div class="tunes-nav-item active" data-view="discover">🔥 Discover</div>
          <div class="tunes-nav-item" data-view="library">📚 My Library</div>
          <div class="tunes-nav-item" data-view="music">🎵 Music</div>
          <div class="tunes-nav-item" data-view="podcasts">🎙 Podcasts</div>
          <div class="tunes-nav-item" data-view="playlists">📁 My Playlists</div>
        </div>
        <button class="primary" data-act="upload" style="margin-top:14px">⬆ Upload track</button>
        <div class="muted" style="font-size:11.5px;margin-top:6px">Accepted: ${TUNE_ACCEPTED_EXTS.join(", ")}. Limit ${TUNE_MAX_BYTES/1024/1024} MB.</div>
        <button data-act="newpl" style="margin-top:6px">＋ New playlist</button>
        <input type="file" accept="audio/*" multiple data-bind="file" style="display:none">
      </div>
      <div class="tunes-main">
        <div class="app-toolbar">
          <input type="search" class="grow" placeholder="Search tracks…" data-bind="q">
          <span class="muted" data-bind="status" style="font-size:12px"></span>
        </div>
        <div data-bind="list" class="tunes-list">Loading…</div>
      </div>
      <div class="tunes-player">
        <div class="tunes-now">
          <div class="tunes-cover" data-bind="np-cover">🎵</div>
          <div style="min-width:0;flex:1">
            <div class="tunes-np-title" data-bind="np-title">Nothing playing</div>
            <div class="tunes-np-artist" data-bind="np-artist"></div>
          </div>
        </div>
        <audio data-bind="audio" controls style="flex:1;min-width:200px"></audio>
      </div>
    </div>
  `;

  const listEl   = host.querySelector('[data-bind="list"]');
  const searchEl = host.querySelector('[data-bind="q"]');
  const audio    = host.querySelector('[data-bind="audio"]');
  const npTitle  = host.querySelector('[data-bind="np-title"]');
  const npArtist = host.querySelector('[data-bind="np-artist"]');
  const npCover  = host.querySelector('[data-bind="np-cover"]');
  const status   = host.querySelector('[data-bind="status"]');
  const fileInput = host.querySelector('[data-bind="file"]');

  let view = "discover";
  let allTunes = [];
  let playlists = [];

  const navItems = host.querySelectorAll(".tunes-nav-item");
  navItems.forEach((el) => el.addEventListener("click", () => {
    navItems.forEach((x) => x.classList.toggle("active", x === el));
    view = el.dataset.view;
    render();
  }));

  const unsub = subscribeTunes((list) => {
    allTunes = list;
    render();
  });

  async function reloadPlaylists() {
    playlists = await listPlaylists(ctx.user.uid);
    if (view === "playlists") render();
  }
  reloadPlaylists();

  function filteredTracks() {
    const q = (searchEl.value || "").toLowerCase();
    let list = allTunes;
    if (view === "library") list = list.filter((t) => t.ownerUid === ctx.user.uid);
    else if (view === "music")    list = list.filter((t) => t.kind !== "podcast");
    else if (view === "podcasts") list = list.filter((t) => t.kind === "podcast");
    if (q) list = list.filter((t) =>
      (t.title || "").toLowerCase().includes(q) ||
      (t.artist || "").toLowerCase().includes(q) ||
      (t.ownerUsername || "").toLowerCase().includes(q));
    return list;
  }

  function render() {
    if (view === "playlists") return renderPlaylists();
    const tracks = filteredTracks();
    if (tracks.length === 0) {
      listEl.innerHTML = `<div class="muted" style="padding:30px;text-align:center">No tracks here yet.${view === "library" ? " Upload one!" : ""}</div>`;
      return;
    }
    listEl.innerHTML = tracks.map((t) => `
      <div class="tunes-row" data-id="${escapeHtml(t.id)}">
        <div class="tunes-cover">${t.cover ? `<img src="${escapeHtml(t.cover)}" alt="">` : (t.kind === "podcast" ? "🎙" : "🎵")}</div>
        <div class="tunes-meta">
          <div class="tunes-title">${escapeHtml(t.title || "Untitled")}</div>
          <div class="tunes-sub">${escapeHtml(t.artist || "")} · @${escapeHtml(t.ownerUsername || "anon")} · ${(t.plays || 0)} play${t.plays === 1 ? "" : "s"}</div>
        </div>
        <div class="tunes-actions">
          <button class="primary" data-act="play">▶</button>
          ${t.ownerUid === ctx.user.uid ? `<button class="danger" data-act="del">×</button>` : ""}
        </div>
      </div>
    `).join("");
    listEl.querySelectorAll(".tunes-row").forEach((row) => {
      const t = tracks.find((x) => x.id === row.dataset.id);
      row.querySelector('[data-act="play"]').onclick = () => play(t);
      const delBtn = row.querySelector('[data-act="del"]');
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm(`Delete "${t.title}"?`)) return;
        await deleteTune(t.id);
      };
    });
  }

  function renderPlaylists() {
    if (playlists.length === 0) {
      listEl.innerHTML = `<div class="muted" style="padding:30px;text-align:center">No playlists. Click "＋ New playlist" to make one.</div>`;
      return;
    }
    listEl.innerHTML = playlists.map((p) => `
      <div class="tunes-row" data-pid="${escapeHtml(p.id)}">
        <div class="tunes-cover">📁</div>
        <div class="tunes-meta">
          <div class="tunes-title">${escapeHtml(p.name)}</div>
          <div class="tunes-sub">${(p.trackIds || []).length} track${(p.trackIds || []).length === 1 ? "" : "s"}</div>
        </div>
        <div class="tunes-actions">
          <button data-act="open">Open</button>
          <button class="danger" data-act="del">×</button>
        </div>
      </div>
    `).join("");
    listEl.querySelectorAll(".tunes-row").forEach((row) => {
      const p = playlists.find((x) => x.id === row.dataset.pid);
      row.querySelector('[data-act="open"]').onclick = () => openPlaylist(p);
      row.querySelector('[data-act="del"]').onclick = async () => {
        if (!confirm(`Delete playlist "${p.name}"?`)) return;
        await deletePlaylist(ctx.user.uid, p.id);
        reloadPlaylists();
      };
    });
  }

  function openPlaylist(p) {
    const ids = p.trackIds || [];
    const items = ids.map((id) => allTunes.find((t) => t.id === id)).filter(Boolean);
    if (items.length === 0) {
      listEl.innerHTML = `<div style="padding:30px;text-align:center" class="muted">Playlist is empty. Pick tracks from Discover and add via the menu.</div>
        <button data-act="back" style="margin-left:30px">← Back to playlists</button>`;
      listEl.querySelector('[data-act="back"]').onclick = () => render();
      return;
    }
    listEl.innerHTML = `
      <button data-act="back" style="margin:10px 0 14px">← Back to playlists</button>
      <h3 style="margin:0 0 12px">${escapeHtml(p.name)}</h3>
    ` + items.map((t) => `
      <div class="tunes-row" data-id="${escapeHtml(t.id)}">
        <div class="tunes-cover">🎵</div>
        <div class="tunes-meta">
          <div class="tunes-title">${escapeHtml(t.title)}</div>
          <div class="tunes-sub">${escapeHtml(t.artist || "")} · @${escapeHtml(t.ownerUsername || "anon")}</div>
        </div>
        <div class="tunes-actions">
          <button class="primary" data-act="play">▶</button>
        </div>
      </div>
    `).join("");
    listEl.querySelector('[data-act="back"]').onclick = () => render();
    listEl.querySelectorAll(".tunes-row").forEach((row) => {
      const t = items.find((x) => x.id === row.dataset.id);
      row.querySelector('[data-act="play"]').onclick = () => play(t);
    });
  }

  async function play(t) {
    status.textContent = "Loading…";
    const blob = await getTuneBlob(t.id);
    status.textContent = "";
    if (!blob) { alert("Track not available."); return; }
    audio.src = blob;
    audio.play().catch(() => {});
    npTitle.textContent = t.title || "Untitled";
    npArtist.textContent = (t.artist || "@" + (t.ownerUsername || ""));
    npCover.innerHTML = t.cover ? `<img src="${escapeHtml(t.cover)}" alt="">` : (t.kind === "podcast" ? "🎙" : "🎵");
    incrementTunePlays(t.id);
  }

  searchEl.addEventListener("input", render);

  host.querySelector('[data-act="upload"]').onclick = () => fileInput.click();
  fileInput.addEventListener("change", async () => {
    for (const f of fileInput.files) {
      if (!isAcceptedAudio(f)) {
        alert(`"${f.name}" is not a supported audio file. Use ${TUNE_ACCEPTED_EXTS.join(", ")}.`);
        continue;
      }
      if (f.size > TUNE_MAX_BYTES) {
        alert(`"${f.name}" is too large (${(f.size/1024/1024).toFixed(1)} MB). Limit is ${TUNE_MAX_BYTES/1024/1024} MB.`);
        continue;
      }
      const title = prompt(`Title for "${f.name}"?`, f.name.replace(/\.[^.]+$/, ""));
      if (title === null) continue;
      const artist = prompt(`Artist? (your username = "${ctx.user.username}")`, ctx.user.username) || ctx.user.username;
      const kindStr = prompt(`Type? type "podcast" for podcast, anything else = music`, "music");
      const kind = (kindStr || "").toLowerCase().trim() === "podcast" ? "podcast" : "music";
      try {
        status.textContent = `Uploading ${title}…`;
        await publishTune(ctx.user.uid, ctx.user.username, f, { title, artist, kind });
        status.textContent = "Uploaded ✓";
      } catch (e) {
        alert(`Upload failed: ${e.message}`);
      }
    }
    fileInput.value = "";
    status.textContent = "";
  });

  host.querySelector('[data-act="newpl"]').onclick = async () => {
    const name = prompt("Playlist name?");
    if (!name) return;
    await createPlaylist(ctx.user.uid, name);
    await reloadPlaylists();
    view = "playlists";
    navItems.forEach((x) => x.classList.toggle("active", x.dataset.view === "playlists"));
    render();
  };

  return () => unsub();
}

function isAcceptedAudio(file) {
  const name = (file?.name || "").toLowerCase();
  return file?.type?.startsWith("audio/") || TUNE_ACCEPTED_EXTS.some((ext) => name.endsWith(ext));
}
