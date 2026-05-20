// BlizzTube — YouTube-style. Users UPLOAD video files; the OS stores them
// in Firebase (blob split out for fast listing). Each video has a title,
// description, and tags. Plays via a <video> element; legacy URL-based entries
// still work via iframe/<video>.

import {
  listTubes, publishTubeFile, getTube, getTubeBlob, incrementTubeView, deleteTube,
  subscribeTubeComments, addTubeComment,
  TUBE_MAX_BYTES
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";

export async function mountTube(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="app-toolbar">
        <input type="search" class="grow" placeholder="Search videos…" data-bind="q" />
        <button class="primary" data-act="post">⬆ Upload video</button>
        <button data-act="refresh">⟳</button>
      </div>
      <div class="tube" data-bind="root"></div>
    </div>
  `;

  const stage = root.querySelector('[data-bind="root"]');
  const search = root.querySelector('[data-bind="q"]');
  let all = [];
  let activeCleanup = null;

  async function refresh() {
    all = await listTubes();
    renderGrid();
  }

  function renderGrid() {
    if (activeCleanup) { activeCleanup(); activeCleanup = null; }
    const q = (search.value || "").toLowerCase().trim();
    const filtered = all.filter((t) => {
      if (!q) return true;
      if (q.startsWith("#")) {
        const want = q.slice(1);
        return (t.tags || []).some((tag) => tag.toLowerCase().includes(want));
      }
      return (t.title || "").toLowerCase().includes(q)
          || (t.description || "").toLowerCase().includes(q)
          || (t.authorUsername || "").toLowerCase().includes(q)
          || (t.tags || []).some((tag) => tag.toLowerCase().includes(q));
    });
    if (filtered.length === 0) {
      stage.innerHTML = `<div class="muted" style="padding:40px;text-align:center">${q ? "No videos match." : "No videos yet. Be the first to upload one!"}</div>`;
      return;
    }
    stage.innerHTML = `
      <div class="tube-grid">
        ${filtered.map((t) => `
          <div class="tube-card" data-id="${escapeHtml(t.id)}">
            <div class="tube-card-thumb">${thumbHtml(t)}</div>
            <div class="tube-card-body">
              <div class="tube-card-title">${escapeHtml(t.title || "Untitled")}</div>
              <div class="tube-card-meta">@${escapeHtml(t.authorUsername || "anon")} · ${t.views || 0} view${t.views === 1 ? "" : "s"}</div>
              ${(t.tags && t.tags.length) ? `<div class="tube-card-tags">${t.tags.slice(0, 3).map((tag) => `<span class="tube-tag">#${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    `;
    stage.querySelectorAll(".tube-card").forEach((c) =>
      c.addEventListener("click", () => openVideo(c.dataset.id))
    );
  }

  async function openVideo(id) {
    if (activeCleanup) activeCleanup();
    const v = await getTube(id);
    if (!v) return;
    incrementTubeView(id);

    stage.innerHTML = `
      <div class="tube-player">
        <div class="tube-player-top">
          <button data-act="back">← Back</button>
          <span class="grow" style="flex:1"></span>
          ${v.authorUid === ctx.user.uid ? `<button class="danger" data-act="delete">Delete video</button>` : ""}
        </div>
        <div class="tube-player-frame" data-bind="frame">
          <div class="muted" style="color:#aaa">Loading…</div>
        </div>
        <div class="tube-player-info">
          <h2>${escapeHtml(v.title || "Untitled")}</h2>
          <div class="tube-player-meta">Uploaded by @${escapeHtml(v.authorUsername || "anon")} · ${(v.views || 0) + 1} view${(v.views || 0) + 1 === 1 ? "" : "s"} · ${new Date(v.createdAt || 0).toLocaleString()}</div>
          ${(v.tags && v.tags.length) ? `<div class="tube-card-tags" style="margin-top:6px">${v.tags.map((tag) => `<span class="tube-tag" data-tag="${escapeHtml(tag)}" style="cursor:pointer">#${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
          ${v.description ? `<div class="tube-player-desc">${escapeHtml(v.description)}</div>` : ""}
        </div>
        <div class="tube-comments" data-bind="comments"></div>
        <div class="tube-input-bar">
          <input type="text" placeholder="Add a comment…" data-bind="ci" />
          <button class="primary" data-act="send">Send</button>
        </div>
      </div>
    `;

    const frameEl = stage.querySelector('[data-bind="frame"]');

    if (v.kind === "upload") {
      // Fetch the blob lazily
      const blob = await getTubeBlob(id);
      if (!blob) {
        frameEl.innerHTML = `<div style="padding:30px;color:#fff;text-align:center">Video unavailable.</div>`;
      } else {
        frameEl.innerHTML = `<video src="${escapeHtml(blob)}" controls autoplay></video>`;
      }
    } else {
      // Legacy URL-based entry
      frameEl.innerHTML = renderLegacyPlayer(v);
    }

    const commentsEl = stage.querySelector('[data-bind="comments"]');
    const ci = stage.querySelector('[data-bind="ci"]');

    const unsub = subscribeTubeComments(id, (c) => {
      const node = document.createElement("div");
      node.className = "tube-comment";
      node.innerHTML = `
        <div class="tube-comment-avatar">${escapeHtml((c.username || "?")[0].toUpperCase())}</div>
        <div class="tube-comment-body">
          <div class="tube-comment-head">@${escapeHtml(c.username || "anon")} · ${new Date(c.ts || 0).toLocaleString()}</div>
          <div class="tube-comment-text">${escapeHtml(c.text || "")}</div>
        </div>
      `;
      commentsEl.appendChild(node);
      commentsEl.scrollTop = commentsEl.scrollHeight;
    });
    activeCleanup = unsub;

    stage.querySelector('[data-act="back"]').onclick = () => renderGrid();
    const delBtn = stage.querySelector('[data-act="delete"]');
    if (delBtn) delBtn.onclick = async () => {
      if (!confirm(`Delete "${v.title}"?`)) return;
      await deleteTube(id);
      refresh();
    };
    stage.querySelectorAll(".tube-tag[data-tag]").forEach((tag) =>
      tag.addEventListener("click", () => {
        search.value = "#" + tag.dataset.tag;
        renderGrid();
      })
    );

    const send = () => {
      const t = ci.value.trim();
      if (!t) return;
      addTubeComment(id, ctx.user.uid, ctx.user.username, t);
      ci.value = "";
    };
    stage.querySelector('[data-act="send"]').onclick = send;
    ci.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  }

  root.querySelector('[data-act="refresh"]').addEventListener("click", refresh);
  root.querySelector('[data-act="post"]').addEventListener("click", () => openUploadDialog(ctx, refresh));
  search.addEventListener("input", renderGrid);

  await refresh();

  return () => { if (activeCleanup) activeCleanup(); };
}

function thumbHtml(t) {
  if (t.thumb && t.thumb.startsWith("data:")) {
    return `<img src="${escapeHtml(t.thumb)}" alt="" loading="lazy">`;
  }
  // Legacy YouTube URL? Use YT thumbnail.
  const yt = parseYouTube(t.url || "");
  if (yt) return `<img src="https://img.youtube.com/vi/${escapeHtml(yt)}/mqdefault.jpg" alt="" loading="lazy">`;
  return "🎬";
}

function renderLegacyPlayer(v) {
  const yt = parseYouTube(v.url || "");
  if (yt) return `<iframe src="https://www.youtube.com/embed/${escapeHtml(yt)}" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"></iframe>`;
  if (/\.(mp4|webm|ogg|mov)(\?|$)/i.test(v.url || "")) {
    return `<video src="${escapeHtml(v.url)}" controls preload="metadata"></video>`;
  }
  const vimeo = (v.url || "").match(/vimeo\.com\/(\d+)/);
  if (vimeo) return `<iframe src="https://player.vimeo.com/video/${escapeHtml(vimeo[1])}" allowfullscreen></iframe>`;
  return `<iframe src="${escapeHtml(v.url || "")}" allowfullscreen></iframe>`;
}

function parseYouTube(url) {
  const m = (url || "").match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

function openUploadDialog(ctx, onDone) {
  const overlay = document.createElement("div");
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(5,9,18,0.7);z-index:5000;display:flex;align-items:center;justify-content:center`;
  overlay.innerHTML = `
    <div style="width:640px;max-width:96vw;background:var(--bg-1);border:1px solid var(--line-strong);border-radius:10px;padding:18px;box-shadow:var(--shadow-2);user-select:text">
      <h3 style="margin:0 0 12px;font-weight:500">Upload a video</h3>
      <div class="col" style="gap:10px">
        <div class="row" style="gap:12px;align-items:flex-start">
          <div data-bind="thumb-box"
            style="width:200px;height:112px;flex-shrink:0;background:linear-gradient(135deg,#2a3553,#1a2238);border:1px dashed var(--line-strong);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:32px;color:var(--text-2);position:relative;overflow:hidden">
            <span data-bind="thumb-placeholder">🎬</span>
            <video data-bind="thumb-vid" style="width:100%;height:100%;object-fit:cover;display:none" muted></video>
            <img data-bind="thumb-img" style="width:100%;height:100%;object-fit:cover;display:none">
          </div>
          <div style="flex:1;min-width:0">
            <input type="file" data-bind="file" accept="video/*" style="display:none">
            <button class="primary" data-act="pick" style="width:100%;padding:10px">Select video file…</button>
            <div class="muted" style="font-size:11.5px;margin-top:8px" data-bind="filemeta">No file selected. .mp4/.webm/.mov · Limit ${TUBE_MAX_BYTES/1024/1024} MB.</div>
          </div>
        </div>
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Title</span>
          <input id="uv-title" type="text" maxlength="100"
            style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none"></label>
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Description</span>
          <textarea id="uv-desc" rows="3"
            style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none;resize:vertical;font-family:inherit"></textarea></label>
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Tags (comma-separated)</span>
          <input id="uv-tags" type="text" placeholder="gaming, music, tutorial"
            style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none"></label>
      </div>
      <div data-bind="progress" style="display:none;margin-top:12px">
        <div style="height:6px;background:var(--bg-3);border-radius:3px;overflow:hidden">
          <div data-bind="bar" style="height:100%;background:var(--accent);width:0%;transition:width 0.2s"></div>
        </div>
        <div data-bind="stage" class="muted" style="font-size:11.5px;margin-top:4px">Uploading…</div>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px;gap:8px">
        <button data-act="cancel">Cancel</button>
        <button class="primary" data-act="submit" disabled>Upload</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const fileInput   = overlay.querySelector('[data-bind="file"]');
  const fileMeta    = overlay.querySelector('[data-bind="filemeta"]');
  const submitBtn   = overlay.querySelector('[data-act="submit"]');
  const placeholder = overlay.querySelector('[data-bind="thumb-placeholder"]');
  const thumbVid    = overlay.querySelector('[data-bind="thumb-vid"]');
  const thumbImg    = overlay.querySelector('[data-bind="thumb-img"]');
  const progressBox = overlay.querySelector('[data-bind="progress"]');
  const progressBar = overlay.querySelector('[data-bind="bar"]');
  const stageText   = overlay.querySelector('[data-bind="stage"]');
  let selectedFile = null;
  let thumbDataUrl = "";

  overlay.querySelector('[data-act="pick"]').onclick = () => fileInput.click();
  overlay.querySelector('[data-act="cancel"]').onclick = () => overlay.remove();

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("video/")) { alert("Please pick a video file."); return; }
    if (f.size > TUBE_MAX_BYTES) {
      alert(`File too large (${(f.size/1024/1024).toFixed(1)} MB). Max is ${TUBE_MAX_BYTES/1024/1024} MB.`);
      return;
    }
    selectedFile = f;
    fileMeta.textContent = `${f.name} · ${(f.size/1024/1024).toFixed(2)} MB · ${f.type}`;
    submitBtn.disabled = false;
    // Auto-fill title from filename if empty
    const titleEl = overlay.querySelector("#uv-title");
    if (!titleEl.value.trim()) titleEl.value = f.name.replace(/\.[^.]+$/, "");

    // Generate thumbnail from first frame
    placeholder.style.display = "none";
    thumbVid.style.display = "block";
    thumbVid.src = URL.createObjectURL(f);
    thumbVid.addEventListener("loadeddata", () => {
      try {
        thumbVid.currentTime = Math.min(1, (thumbVid.duration || 1) * 0.1);
      } catch {}
    }, { once: true });
    thumbVid.addEventListener("seeked", () => {
      try {
        const canvas = document.createElement("canvas");
        const w = 320, ratio = thumbVid.videoWidth ? (thumbVid.videoHeight / thumbVid.videoWidth) : (9/16);
        canvas.width = w; canvas.height = Math.round(w * ratio);
        const cx = canvas.getContext("2d");
        cx.drawImage(thumbVid, 0, 0, canvas.width, canvas.height);
        thumbDataUrl = canvas.toDataURL("image/jpeg", 0.75);
        thumbImg.src = thumbDataUrl;
        thumbImg.style.display = "block";
        thumbVid.style.display = "none";
      } catch {}
    }, { once: true });
  });

  submitBtn.onclick = async () => {
    if (!selectedFile) return;
    const title = overlay.querySelector("#uv-title").value.trim();
    const description = overlay.querySelector("#uv-desc").value.trim();
    const tagStr = overlay.querySelector("#uv-tags").value.trim();
    if (!title) { alert("Title is required."); return; }
    const tags = tagStr
      ? tagStr.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 10)
      : [];

    submitBtn.disabled = true;
    progressBox.style.display = "block";
    progressBar.style.width = "10%";
    stageText.textContent = "Encoding…";
    await new Promise((r) => setTimeout(r, 30));   // let the UI paint
    progressBar.style.width = "55%";
    stageText.textContent = "Uploading to Blizzard…";

    try {
      await publishTubeFile(ctx.user.uid, ctx.user.username, selectedFile, {
        title, description, tags, thumb: thumbDataUrl
      });
      progressBar.style.width = "100%";
      stageText.textContent = "Done.";
      setTimeout(() => { overlay.remove(); onDone(); }, 300);
    } catch (e) {
      alert("Upload failed: " + e.message);
      submitBtn.disabled = false;
      progressBox.style.display = "none";
    }
  };
}
