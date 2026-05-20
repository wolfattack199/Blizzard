// File Explorer — browse the local FS plus the user's Cloud (synced) files.
import * as FS from "../fs.js";
import { escapeHtml } from "../os/wm.js";
import { loadUser } from "../firebase.js";
import { pickUser } from "../os/userpicker.js";

const SHORTCUTS = [
  { label: "Home",       path: "/",                glyph: "🏠" },
  { label: "Documents",  path: "/Documents",       glyph: "📄" },
  { label: "Pictures",   path: "/Pictures",        glyph: "🖼" },
  { label: "Downloads",  path: "/Downloads",       glyph: "⬇" },
  { label: "Projects",   path: "/Projects",        glyph: "🛠" },
  { sep: true,           label: "Cloud" },
  { label: "My Files",   path: FS.CLOUD_MINE,      glyph: "☁" },
  { label: "Shared",     path: FS.CLOUD_SHARED,    glyph: "👥" }
];

export async function mountFiles(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="files-tabs" data-bind="ftabs"></div>
      <div class="app-toolbar">
        <button data-act="up" title="Up">↑</button>
        <button data-act="new-folder">New folder</button>
        <button data-act="new-file">New file</button>
        <button class="primary" data-act="upload">⬆ Upload</button>
        <input type="file" multiple style="display:none" data-bind="picker">
        <input type="text" class="grow" data-act="path-input" />
        <button data-act="refresh">⟳</button>
      </div>
      <div class="files">
        <div class="files-sidebar"></div>
        <div class="files-main">
          <div class="files-path"></div>
          <div class="files-list"></div>
        </div>
      </div>
    </div>
  `;

  const sidebar  = root.querySelector(".files-sidebar");
  const list     = root.querySelector(".files-list");
  const pathBar  = root.querySelector(".files-path");
  const pathIn   = root.querySelector('[data-act="path-input"]');
  const picker   = root.querySelector('[data-bind="picker"]');

  // Multi-tab state. Each tab has its own cwd. Persists per session.
  const fTabsEl = root.querySelector('[data-bind="ftabs"]');
  let tabs = [{ id: 1, cwd: ctx.initialPath ? FS.normalize(ctx.initialPath) : "/" }];
  let activeTabId = 1;
  let nextTabId = 2;

  function activeTab() { return tabs.find((t) => t.id === activeTabId); }
  let cwd = activeTab().cwd;

  function renderTabs() {
    fTabsEl.innerHTML = tabs.map((t) => `
      <div class="files-tab${t.id === activeTabId ? " active" : ""}" data-id="${t.id}">
        <span class="files-tab-title">${escapeHtml(t.cwd.split("/").filter(Boolean).pop() || "Home")}</span>
        ${tabs.length > 1 ? `<span class="files-tab-close" data-close="${t.id}">×</span>` : ""}
      </div>
    `).join("") + `<div class="files-tab-new" data-act="new-tab">+</div>`;
    fTabsEl.querySelectorAll(".files-tab").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("files-tab-close")) {
          const id = parseInt(e.target.dataset.close, 10);
          tabs = tabs.filter((t) => t.id !== id);
          if (activeTabId === id) activeTabId = tabs[0].id;
          cwd = activeTab().cwd;
          renderTabs();
          renderSidebar();
          renderList();
        } else {
          activeTabId = parseInt(el.dataset.id, 10);
          cwd = activeTab().cwd;
          renderTabs();
          renderSidebar();
          renderList();
        }
      });
    });
    fTabsEl.querySelector('[data-act="new-tab"]').addEventListener("click", () => {
      const t = { id: nextTabId++, cwd: "/" };
      tabs.push(t);
      activeTabId = t.id;
      cwd = "/";
      renderTabs();
      renderSidebar();
      renderList();
    });
  }

  function renderSidebar() {
    let html = "";
    for (const s of SHORTCUTS) {
      if (s.sep) {
        html += `<div class="files-section-title">${escapeHtml(s.label)}</div>`;
      } else {
        html += `<div class="files-shortcut${s.path === cwd ? " active" : ""}" data-path="${escapeHtml(s.path)}">
          <span>${s.glyph}</span><span>${escapeHtml(s.label)}</span>
        </div>`;
      }
    }
    // Header at the top
    sidebar.innerHTML = `<div class="files-section-title">Quick Access</div>` + html;
    sidebar.querySelectorAll(".files-shortcut").forEach((el) =>
      el.addEventListener("click", () => navigate(el.dataset.path))
    );
  }

  async function renderList() {
    pathBar.textContent = cwd + (FS.isCloudPath(cwd) ? "    ☁ synced" : "    💾 this device");
    pathIn.value = cwd;
    const items = await FS.list(cwd);

    // Upload button visibility — only meaningful where you can write
    const canUpload = !FS.isSharedPath(cwd);
    root.querySelector('[data-act="upload"]').style.display = canUpload ? "" : "none";
    root.querySelector('[data-act="new-file"]').style.display = canUpload ? "" : "none";
    root.querySelector('[data-act="new-folder"]').style.display = canUpload ? "" : "none";

    if (items.length === 0) {
      list.innerHTML = `<div class="muted" style="padding:20px;grid-column:1/-1">${
        FS.isSharedPath(cwd) ? "Nobody has shared anything with you yet." : "This folder is empty."
      }</div>`;
      return;
    }
    list.innerHTML = items.map((it) => `
      <div class="file-item" data-path="${escapeHtml(it.path)}" data-dir="${it.isDir ? '1' : '0'}" data-cloud="${it.cloud ? '1' : '0'}" data-shared="${it.shared ? '1' : '0'}">
        <div class="file-glyph">${FS.fileIcon(it)}${it.shared && !it.isDir ? '<span style="font-size:11px;position:relative;top:-12px;left:-6px">👥</span>' : ""}</div>
        <div class="file-name">${escapeHtml(it.name)}</div>
      </div>
    `).join("");

    list.querySelectorAll(".file-item").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey) {
          el.classList.toggle("selected");
        } else if (e.shiftKey) {
          // Extend selection from anchor to this item
          const all = [...list.querySelectorAll(".file-item")];
          const anchor = all.findIndex((x) => x.classList.contains("selected"));
          const here = all.indexOf(el);
          if (anchor >= 0) {
            const [lo, hi] = [Math.min(anchor, here), Math.max(anchor, here)];
            all.forEach((x, i) => x.classList.toggle("selected", i >= lo && i <= hi));
          } else {
            el.classList.add("selected");
          }
        } else {
          list.querySelectorAll(".file-item").forEach((d) => d.classList.remove("selected"));
          el.classList.add("selected");
        }
        e.stopPropagation();
      });
      el.addEventListener("dblclick", () => openItem(el.dataset.path, el.dataset.dir === "1"));
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!el.classList.contains("selected")) {
          list.querySelectorAll(".file-item").forEach((d) => d.classList.remove("selected"));
          el.classList.add("selected");
        }
        const selected = [...list.querySelectorAll(".file-item.selected")];
        if (selected.length > 1) showMultiMenu(e.clientX, e.clientY, selected);
        else showItemMenu(e.clientX, e.clientY, el.dataset.path, el.dataset.dir === "1");
      });
    });

  }

  // Rubber-band drag selection. Attached once; document listeners survive renders.
  let drag = null;
  list.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".file-item")) return;
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
      list.querySelectorAll(".file-item").forEach((d) => d.classList.remove("selected"));
    }
    const lr = list.getBoundingClientRect();
    const startX = e.clientX - lr.left + list.scrollLeft;
    const startY = e.clientY - lr.top + list.scrollTop;
    const marquee = document.createElement("div");
    marquee.className = "files-marquee";
    list.appendChild(marquee);
    drag = {
      startX, startY, marquee,
      additive: e.ctrlKey || e.metaKey || e.shiftKey,
      preSelected: new Set([...list.querySelectorAll(".file-item.selected")].map((x) => x.dataset.path))
    };
  });
  function onMarqueeMove(ev) {
    if (!drag) return;
    const lr = list.getBoundingClientRect();
    const x = ev.clientX - lr.left + list.scrollLeft;
    const y = ev.clientY - lr.top + list.scrollTop;
    const left   = Math.max(0, Math.min(drag.startX, x));
    const top    = Math.max(0, Math.min(drag.startY, y));
    const right  = Math.max(drag.startX, x);
    const bottom = Math.max(drag.startY, y);
    Object.assign(drag.marquee.style, {
      left: left + "px", top: top + "px",
      width: (right - left) + "px", height: (bottom - top) + "px"
    });
    list.querySelectorAll(".file-item").forEach((it) => {
      const r = it.getBoundingClientRect();
      const ix1 = r.left - lr.left + list.scrollLeft;
      const iy1 = r.top  - lr.top  + list.scrollTop;
      const ix2 = ix1 + r.width;
      const iy2 = iy1 + r.height;
      const hit = ix1 < right && ix2 > left && iy1 < bottom && iy2 > top;
      if (hit) it.classList.add("selected");
      else if (!drag.additive || !drag.preSelected.has(it.dataset.path)) it.classList.remove("selected");
    });
  }
  function onMarqueeUp() {
    if (!drag) return;
    drag.marquee.remove();
    drag = null;
  }
  document.addEventListener("mousemove", onMarqueeMove);
  document.addEventListener("mouseup", onMarqueeUp);

  function navigate(path) {
    cwd = FS.normalize(path);
    const t = activeTab();
    if (t) t.cwd = cwd;
    renderTabs();
    renderSidebar();
    renderList();
  }

  async function openItem(path, isDir) {
    if (isDir) { navigate(path); return; }
    const rec = await FS.read(path);
    if (!rec) return;
    const isHtmlLike = rec.type === "html" || rec.type === "game" || /\.(html|htm|blz)$/i.test(rec.name || path);
    if (isHtmlLike) {
      // Both local + cloud: open inside a Blizzard browser tab.
      const html = FS.isCloudPath(path) ? decodeDataUrl(rec.content) : rec.content;
      ctx.launchApp("browser", { initialHtml: html, initialTitle: rec.name || path.split("/").pop() });
      return;
    }
    if (FS.isCloudPath(path)) {
      openCloudFile(rec);
      return;
    }
    if (rec.type === "image" && (rec.content || "").startsWith("data:")) {
      const w = window.open("", "_blank");
      if (w) w.document.write(`<title>${rec.name || ""}</title><body style="margin:0;background:#222;display:flex;align-items:center;justify-content:center;height:100vh"><img src="${rec.content}"></body>`);
    } else if (rec.type === "audio" && (rec.content || "").startsWith("data:")) {
      const w = window.open("", "_blank");
      if (w) w.document.write(`<title>${rec.name || ""}</title><body style="background:#0b1220;color:#fff;font-family:system-ui;padding:30px"><audio src="${rec.content}" controls autoplay style="width:100%"></audio></body>`);
    } else {
      ctx.launchApp("studios");
    }
  }

  function decodeDataUrl(s) {
    if (typeof s !== "string" || !s.startsWith("data:")) return s || "";
    const comma = s.indexOf(",");
    const meta = s.slice(0, comma);
    const data = s.slice(comma + 1);
    try {
      if (meta.includes(";base64")) return decodeURIComponent(escape(atob(data)));
      return decodeURIComponent(data);
    } catch { return s; }
  }

  function openCloudFile(rec) {
    const dataUrl = rec.content || "";
    const w = window.open("", "_blank");
    if (!w) { alert("Pop-up blocked. Allow pop-ups for this site."); return; }
    if (rec.type === "image") {
      w.document.write(`<title>${rec.name || ""}</title><body style="margin:0;background:#222;display:flex;align-items:center;justify-content:center;height:100vh"><img src="${dataUrl}"></body>`);
    } else if (rec.type === "video") {
      w.document.write(`<title>${rec.name || ""}</title><body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><video src="${dataUrl}" controls autoplay style="max-width:100%;max-height:100%"></video></body>`);
    } else if (rec.type === "audio") {
      w.document.write(`<title>${rec.name || ""}</title><body style="background:#0b1220;color:#fff;font-family:system-ui;padding:30px"><h3>${escapeHtml(rec.name || "")}</h3><audio src="${dataUrl}" controls autoplay style="width:100%"></audio></body>`);
    } else if (rec.type === "pdf") {
      w.location.href = dataUrl;
    } else {
      try {
        const txt = atob((dataUrl.split(",")[1] || ""));
        w.document.write(`<title>${rec.name || ""}</title><body style="margin:0;background:#0b1220;color:#eaf2ff;font-family:ui-monospace,Consolas,monospace;padding:20px;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(txt)}</body>`);
      } catch {
        w.location.href = dataUrl;
      }
    }
  }

  // Toolbar actions
  root.querySelector('[data-act="up"]').addEventListener("click", () => {
    if (cwd === "/") return;
    const parts = cwd.split("/").filter(Boolean);
    parts.pop();
    navigate("/" + parts.join("/"));
  });
  root.querySelector('[data-act="refresh"]').addEventListener("click", renderList);

  root.querySelector('[data-act="new-folder"]').addEventListener("click", async () => {
    const name = prompt("Folder name?");
    if (!name) return;
    try {
      await FS.mkdir(cwd === "/" ? "/" + name : cwd + "/" + name);
      renderList();
    } catch (e) { alert(e.message); }
  });
  root.querySelector('[data-act="new-file"]').addEventListener("click", async () => {
    const name = prompt("File name?");
    if (!name) return;
    try {
      await FS.write(cwd === "/" ? "/" + name : cwd + "/" + name, "");
      renderList();
    } catch (e) { alert(e.message); }
  });
  root.querySelector('[data-act="upload"]').addEventListener("click", () => picker.click());
  picker.addEventListener("change", async () => {
    for (const f of picker.files) {
      try {
        await FS.uploadFile(cwd, f);
      } catch (e) {
        alert(`Failed to upload "${f.name}": ${e.message}`);
      }
    }
    picker.value = "";
    renderList();
  });

  pathIn.addEventListener("keydown", (e) => { if (e.key === "Enter") navigate(pathIn.value); });

  // Empty-area context menu
  list.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".file-item")) return;
    e.preventDefault();
    showFolderMenu(e.clientX, e.clientY);
  });

  function showFolderMenu(x, y) {
    if (FS.isSharedPath(cwd)) { return; }
    showCtxMenu(x, y, [
      { label: "New folder", action: async () => {
          const name = prompt("Folder name?");
          if (name) { try { await FS.mkdir(cwd === "/" ? "/" + name : cwd + "/" + name); renderList(); } catch (e) { alert(e.message); } }
      }},
      { label: "New file", action: async () => {
          const name = prompt("File name?");
          if (name) { try { await FS.write(cwd === "/" ? "/" + name : cwd + "/" + name, ""); renderList(); } catch (e) { alert(e.message); } }
      }},
      { label: "Upload from this device…", action: () => picker.click() },
      { sep: true },
      { label: "Refresh", action: renderList }
    ]);
  }

  function showItemMenu(x, y, path, isDir) {
    const isCloud  = FS.isCloudPath(path);
    const isShared = FS.isSharedPath(path);
    const name = path.split("/").pop();
    const isCodeFile = !isDir && /\.(html?|css|js|json|md|txt|svg)$/i.test(name);
    const isBlzFile  = !isDir && /\.blz$/i.test(name);
    const items = [
      { label: isDir ? "Open" : (isCloud && !isShared ? "Open (new tab)" : "Open"), action: () => openItem(path, isDir) }
    ];
    if (isCodeFile) items.push({ label: "Open in Studios", action: () => openInStudios(path) });
    if (isBlzFile)  items.push({ label: "Unbundle to project…", action: () => unbundleBlz(path) });
    if (isCloud && !isShared && !isDir) {
      items.push({ label: "Share…", action: () => openShareDialog(path) });
    }
    if (!isShared) {
      items.push({ label: "Rename", action: async () => {
          const cur = path.split("/").pop();
          const next = prompt("Rename to:", cur);
          if (!next || next === cur) return;
          const parent = path.split("/").slice(0, -1).join("/") || "/";
          try {
            await FS.rename(path, parent === "/" ? "/" + next : parent + "/" + next);
            renderList();
          } catch (e) { alert(e.message); }
      }});
      items.push({ label: "Delete", action: async () => {
          if (!confirm(`Delete "${path}"?`)) return;
          try { await FS.remove(path); renderList(); } catch (e) { alert(e.message); }
      }});
    }
    showCtxMenu(x, y, items);
  }

  function showMultiMenu(x, y, selectedEls) {
    const paths = selectedEls.map((el) => el.dataset.path);
    const anyShared = paths.some((p) => FS.isSharedPath(p));
    const items = [];
    if (!anyShared) {
      items.push({ label: `Delete ${paths.length} items`, action: async () => {
        if (!confirm(`Delete ${paths.length} items? This cannot be undone.`)) return;
        for (const p of paths) {
          try { await FS.remove(p); } catch (e) { console.warn("Delete failed:", p, e); }
        }
        renderList();
      }});
    }
    items.push({ label: "Deselect all", action: () => {
      list.querySelectorAll(".file-item").forEach((d) => d.classList.remove("selected"));
    }});
    showCtxMenu(x, y, items);
  }

  function openInStudios(path) {
    ctx.launchApp("studios", { initialPath: path });
  }

  async function unbundleBlz(path) {
    const rec = await FS.read(path);
    if (!rec) return;
    const raw = FS.isCloudPath(path) ? decodeDataUrl(rec.content) : (rec.content || "");
    const base = (path.split("/").pop() || "bundle").replace(/\.blz$/i, "").replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "unbundled";
    const projPath = `/Projects/${base}`;
    const existed = await FS.exists(projPath);

    // Detect format: new multi-file bundle starts with {"_blz":...
    const trimmed = raw.trimStart();
    let written = [];
    if (trimmed.startsWith("{") && trimmed.includes('"_blz"')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj && obj._blz && obj.files && typeof obj.files === "object") {
          if (existed && !confirm(`/Projects/${base} already exists. Overwrite?`)) return;
          for (const [rel, content] of Object.entries(obj.files)) {
            const safeRel = rel.replace(/^\/+/, "").replace(/\.\./g, "");
            const filePath = projPath + "/" + safeRel;
            await FS.write(filePath, typeof content === "string" ? content : JSON.stringify(content, null, 2));
            written.push(safeRel);
          }
          if (confirm(`Unbundled ${written.length} file(s) to /Projects/${base}/\n${written.slice(0, 10).map((f) => "· " + f).join("\n")}${written.length > 10 ? "\n…" : ""}\n\nOpen in Studios?`)) {
            const entry = written.find((f) => /index\.html?$/i.test(f)) || written.find((f) => /main\.(py|js)$/i.test(f)) || written[0];
            ctx.launchApp("studios", { initialPath: projPath + "/" + entry });
          }
          return;
        }
      } catch {}
    }

    // Legacy single-file HTML game: split into html/css/js.
    if (existed && !confirm(`/Projects/${base} already exists. Overwrite?`)) return;
    const { indexHtml, css, js } = splitBundle(raw);
    await FS.write(projPath + "/index.html", indexHtml);
    if (css) await FS.write(projPath + "/style.css", css);
    if (js)  await FS.write(projPath + "/app.js",   js);
    if (confirm(`Unbundled to /Projects/${base}/\n· index.html${css ? "\n· style.css" : ""}${js ? "\n· app.js" : ""}\n\nOpen in Studios?`)) {
      ctx.launchApp("studios", { initialPath: projPath + "/index.html" });
    }
  }

  function openShareDialog(path) {
    const sharedUids = FS.cloudSharedWith(path);
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(5,9,18,0.7);z-index:5000;display:flex;align-items:center;justify-content:center`;
    overlay.innerHTML = `
      <div style="width:460px;background:var(--bg-1);border:1px solid var(--line-strong);border-radius:10px;padding:18px;box-shadow:var(--shadow-2);user-select:text">
        <h3 style="margin:0 0 12px;font-weight:500">Share file</h3>
        <div class="muted" style="font-size:12px;margin-bottom:10px">${escapeHtml(path)}</div>
        <button class="primary" id="sh-add" style="width:100%">＋ Share with someone…</button>
        <div id="sh-list" style="margin-top:14px"></div>
        <div class="row" style="justify-content:flex-end;margin-top:14px">
          <button id="sh-close">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    async function refreshList() {
      const target = overlay.querySelector("#sh-list");
      if (sharedUids.length === 0) {
        target.innerHTML = `<div class="muted" style="font-size:12px">Not shared with anyone yet.</div>`;
        return;
      }
      const rows = await Promise.all(sharedUids.map(async (u) => {
        const usr = await loadUser(u);
        return { uid: u, username: usr?.username || u.slice(0, 6) };
      }));
      target.innerHTML = `
        <div class="muted" style="font-size:11px;margin-bottom:6px">Shared with:</div>
        ${rows.map((r) => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--bg-2);border-radius:5px;margin-bottom:4px;font-size:12.5px">
            <span>@${escapeHtml(r.username)}</span>
            <button class="danger" data-uid="${escapeHtml(r.uid)}" style="padding:2px 8px;font-size:11px">Remove</button>
          </div>
        `).join("")}
      `;
      target.querySelectorAll("button[data-uid]").forEach((b) =>
        b.addEventListener("click", async () => {
          try {
            await FS.unshareFile(path, b.dataset.uid);
            const idx = sharedUids.indexOf(b.dataset.uid);
            if (idx >= 0) sharedUids.splice(idx, 1);
            refreshList();
            renderList();
          } catch (e) { alert(e.message); }
        })
      );
    }

    overlay.querySelector("#sh-add").onclick = async () => {
      const picked = await pickUser({
        title: "Share with…",
        label: "Username",
        excludeUid: ctx.user.uid,
        submitLabel: "Share"
      });
      if (!picked) return;
      try {
        await FS.shareFile(path, picked.username);
        const newList = FS.cloudSharedWith(path);
        sharedUids.length = 0;
        for (const u of newList) sharedUids.push(u);
        refreshList();
        renderList();
      } catch (e) { alert(e.message); }
    };
    overlay.querySelector("#sh-close").onclick = () => overlay.remove();
    refreshList();
  }

  const unsub = FS.subscribeFS(() => renderList());

  renderTabs();
  renderSidebar();
  renderList();

  return () => unsub();
}

// Pull <style> blocks and inline <script> blocks out of an HTML bundle into
// standalone style.css / app.js, replacing each with a <link>/<script src>.
function splitBundle(html) {
  const cssParts = [];
  const jsParts  = [];
  let indexHtml = html;

  indexHtml = indexHtml.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, body) => {
    cssParts.push(body.trim());
    return `<link rel="stylesheet" href="style.css">`;
  });
  // Remove duplicate <link rel="stylesheet" href="style.css"> after the first
  let linkSeen = false;
  indexHtml = indexHtml.replace(/<link\s+rel="stylesheet"\s+href="style\.css">/g, (m) => {
    if (linkSeen) return "";
    linkSeen = true;
    return m;
  });

  indexHtml = indexHtml.replace(/<script(\s+[^>]*?)?>([\s\S]*?)<\/script>/gi, (m, attrs, body) => {
    if (attrs && /\bsrc\s*=/i.test(attrs)) return m; // keep external scripts
    if (!body.trim()) return m;
    jsParts.push(body.trim());
    return `<script src="app.js"></script>`;
  });
  let scriptSeen = false;
  indexHtml = indexHtml.replace(/<script\s+src="app\.js"><\/script>/g, (m) => {
    if (scriptSeen) return "";
    scriptSeen = true;
    return m;
  });

  return {
    indexHtml,
    css: cssParts.join("\n\n").trim(),
    js:  jsParts.join("\n\n").trim()
  };
}

function showCtxMenu(x, y, items) {
  const menu = document.getElementById("context-menu");
  menu.innerHTML = "";
  for (const it of items) {
    if (it.sep) {
      const s = document.createElement("div"); s.className = "context-menu-sep"; menu.appendChild(s); continue;
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
}
