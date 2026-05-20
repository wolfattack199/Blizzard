// Site Builder — visual block editor for a single page.
// Project model lives at /Projects/<name>/_builder.json (the source of truth)
// and we also write /Projects/<name>/index.html on save (so Studios / publish work).
//
// Collaboration: when a site is published, the owner can invite collaborators
// (by username). Collaborators see the project in the dropdown of "Shared
// projects" and any edits they save are written back to the live site, refreshing
// the project for everyone with that domain in their list.

import * as FS from "../fs.js";
import {
  publishSite, getSite, listSites, addCollaborator, removeCollaborator,
  lookupUidByUsername, loadUser
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";

const PALETTE = [
  { type: "heading", glyph: "H", label: "Heading", defaults: { text: "Heading", level: "h1" } },
  { type: "text",    glyph: "¶", label: "Paragraph", defaults: { text: "Body copy. Click to edit." } },
  { type: "button",  glyph: "▭", label: "Button", defaults: { text: "Click me", href: "#" } },
  { type: "image",   glyph: "🖼", label: "Image",  defaults: { src: "", alt: "" } },
  { type: "spacer",  glyph: "↕", label: "Spacer", defaults: { height: 24 } },
  { type: "divider", glyph: "—", label: "Divider", defaults: {} }
];

export async function mountBuilder(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="app-toolbar">
        <select data-bind="proj"></select>
        <button data-act="new-proj">＋ New site</button>
        <button data-act="save">💾 Save</button>
        <button class="primary" data-act="publish">⬆ Publish</button>
        <span class="grow"></span>
        <span class="muted" data-bind="status"></span>
      </div>
      <div class="builder">
        <div class="builder-tools">
          <div class="builder-tools-title">Blocks</div>
          ${PALETTE.map((p) => `
            <div class="builder-tool" draggable="true" data-type="${p.type}">
              <span>${p.glyph}</span><span>${p.label}</span>
            </div>
          `).join("")}
          <div class="builder-tools-title" style="margin-top:14px">Page settings</div>
          <label class="col" style="gap:3px"><span class="muted" style="font-size:11px">Page title</span>
            <input data-bind="title" type="text" style="padding:5px 7px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:4px;color:var(--text-0);outline:none" />
          </label>
          <label class="col" style="gap:3px"><span class="muted" style="font-size:11px">Theme</span>
            <select data-bind="theme" style="padding:5px 7px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:4px;color:var(--text-0);outline:none">
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>
        <div class="builder-canvas-wrap">
          <div class="builder-canvas" data-bind="canvas"></div>
        </div>
        <div class="builder-inspector" data-bind="inspector">
          <h4>Inspector</h4>
          <div class="muted">Drag a block onto the canvas to begin.</div>
        </div>
      </div>
    </div>
  `;

  const projSel    = root.querySelector('[data-bind="proj"]');
  const canvas     = root.querySelector('[data-bind="canvas"]');
  const inspector  = root.querySelector('[data-bind="inspector"]');
  const statusEl   = root.querySelector('[data-bind="status"]');
  const titleIn    = root.querySelector('[data-bind="title"]');
  const themeIn    = root.querySelector('[data-bind="theme"]');

  let currentProject = null; // file path of project folder
  let model = newDoc();
  let selectedId = null;

  function newDoc() { return { title: "Untitled site", theme: "light", blocks: [] }; }
  function uid() { return Math.random().toString(36).slice(2, 9); }

  async function refreshProjectList() {
    if (!await FS.exists("/Projects")) await FS.mkdir("/Projects");
    const own = (await FS.list("/Projects")).filter((f) => f.isDir);
    const shared = await sharedProjects(ctx.user.uid);

    projSel.innerHTML = [
      `<optgroup label="My projects">${own.map((p) =>
        `<option value="${escapeHtml(p.path)}">${escapeHtml(p.name)}</option>`).join("")}</optgroup>`,
      shared.length ? `<optgroup label="Shared with me">${shared.map((s) =>
        `<option value="shared:${escapeHtml(s.domain)}">${escapeHtml(s.domain)} (shared)</option>`).join("")}</optgroup>` : ""
    ].join("");

    if (!currentProject && own.length > 0) currentProject = own[0].path;
    if (currentProject) projSel.value = currentProject;
  }

  async function sharedProjects(myUid) {
    const all = await listSites();
    return all.filter((s) => s.collaborators && s.collaborators[myUid]);
  }

  async function loadCurrent() {
    if (!currentProject) { model = newDoc(); render(); return; }
    if (currentProject.startsWith("shared:")) {
      const domain = currentProject.slice(7);
      const site = await getSite(domain);
      if (!site) { model = newDoc(); render(); return; }
      const builderJson = site.files["_builder.json"];
      model = builderJson ? safeParse(builderJson) || newDoc() : importHtmlAsModel(site.files["index.html"] || "");
    } else {
      const rec = await FS.read(currentProject + "/_builder.json");
      if (rec) {
        model = safeParse(rec.content) || newDoc();
      } else {
        const html = (await FS.read(currentProject + "/index.html"))?.content || "";
        model = importHtmlAsModel(html);
      }
    }
    render();
  }

  function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

  function importHtmlAsModel(html) {
    // Best-effort: just put the raw HTML into a single "text" block (read-only-ish).
    return {
      title: (html.match(/<title>([^<]*)<\/title>/i)?.[1] || "Imported site"),
      theme: "light",
      blocks: [{ id: uid(), type: "text", text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "Imported content" }]
    };
  }

  function render() {
    titleIn.value = model.title || "";
    themeIn.value = model.theme || "light";
    canvas.style.background = model.theme === "dark" ? "#0b1220" : "#ffffff";
    canvas.style.color = model.theme === "dark" ? "#eaf2ff" : "#111";
    canvas.innerHTML = model.blocks.map(renderBlock).join("");
    canvas.querySelectorAll(".b-block").forEach((el) => {
      el.addEventListener("click", (e) => { e.stopPropagation(); selectBlock(el.dataset.id); });
    });
    renderInspector();
  }

  function renderBlock(b) {
    const sel = b.id === selectedId ? " selected" : "";
    switch (b.type) {
      case "heading": return `<div class="b-block${sel}" data-id="${b.id}" data-type="heading">
          <${b.level || "h1"} style="margin:0">${escapeHtml(b.text || "")}</${b.level || "h1"}></div>`;
      case "text":    return `<div class="b-block${sel}" data-id="${b.id}" data-type="text">
          <p style="margin:0">${escapeHtml(b.text || "")}</p></div>`;
      case "button":  return `<div class="b-block${sel}" data-id="${b.id}" data-type="button">
          <button>${escapeHtml(b.text || "Button")}</button></div>`;
      case "image":   return `<div class="b-block${sel}" data-id="${b.id}" data-type="image">
          ${b.src ? `<img src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt || "")}">` : `<div style="padding:30px;text-align:center;border:1px dashed #aaa;color:#888">Image (set src)</div>`}
        </div>`;
      case "spacer":  return `<div class="b-block${sel}" data-id="${b.id}" data-type="spacer"
          style="height:${parseInt(b.height || 24, 10)}px"></div>`;
      case "divider": return `<div class="b-block${sel}" data-id="${b.id}" data-type="divider">
          <hr style="border:none;border-top:1px solid currentColor;opacity:0.3"></div>`;
      default: return "";
    }
  }

  function selectBlock(id) {
    selectedId = id;
    canvas.querySelectorAll(".b-block").forEach((el) => el.classList.toggle("selected", el.dataset.id === id));
    renderInspector();
  }

  function renderInspector() {
    const b = model.blocks.find((x) => x.id === selectedId);
    if (!b) {
      inspector.innerHTML = `
        <h4>Inspector</h4>
        <div class="muted">Select a block to edit its properties.</div>
        ${currentProject?.startsWith("shared:") ? "" : `
          <h4 style="margin-top:18px">Collaborators</h4>
          <div data-bind="collab-list" class="builder-collab-list"></div>
          <div class="row" style="gap:4px"><input data-bind="collab-add" type="text" placeholder="username" style="flex:1;padding:5px 7px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:4px;color:var(--text-0);outline:none;font-size:12px" /><button data-act="add-collab">Add</button></div>
          <div class="muted" style="font-size:11px;margin-top:6px">Collaborators can edit a published site. Publish first.</div>
        `}
      `;
      if (!currentProject?.startsWith("shared:")) wireCollabUI();
      return;
    }
    let props = "";
    if (b.type === "heading") {
      props = `
        <div class="builder-prop"><label>Text</label><input type="text" data-prop="text" value="${escapeHtml(b.text || "")}" /></div>
        <div class="builder-prop"><label>Level</label>
          <select data-prop="level">
            ${["h1","h2","h3","h4"].map((l) => `<option ${b.level===l?"selected":""}>${l}</option>`).join("")}
          </select>
        </div>`;
    } else if (b.type === "text") {
      props = `<div class="builder-prop"><label>Text</label><textarea data-prop="text" rows="5">${escapeHtml(b.text || "")}</textarea></div>`;
    } else if (b.type === "button") {
      props = `
        <div class="builder-prop"><label>Label</label><input type="text" data-prop="text" value="${escapeHtml(b.text || "")}" /></div>
        <div class="builder-prop"><label>Link (href)</label><input type="text" data-prop="href" value="${escapeHtml(b.href || "")}" /></div>`;
    } else if (b.type === "image") {
      props = `
        <div class="builder-prop"><label>Image URL</label><input type="text" data-prop="src" value="${escapeHtml(b.src || "")}" /></div>
        <div class="builder-prop"><label>Alt text</label><input type="text" data-prop="alt" value="${escapeHtml(b.alt || "")}" /></div>`;
    } else if (b.type === "spacer") {
      props = `<div class="builder-prop"><label>Height (px)</label><input type="number" data-prop="height" value="${b.height || 24}" /></div>`;
    }

    inspector.innerHTML = `
      <h4>${b.type[0].toUpperCase() + b.type.slice(1)}</h4>
      ${props}
      <div class="row" style="gap:6px;margin-top:10px">
        <button data-act="move-up">↑ Up</button>
        <button data-act="move-down">↓ Down</button>
        <button class="danger" data-act="delete">Delete</button>
      </div>
    `;
    inspector.querySelectorAll("[data-prop]").forEach((inp) => {
      const handler = () => {
        const val = inp.tagName === "INPUT" && inp.type === "number" ? parseInt(inp.value, 10) : inp.value;
        b[inp.dataset.prop] = val;
        render();
        // Re-select after re-render (render rebuilds DOM)
        selectBlock(b.id);
      };
      inp.addEventListener("input", handler);
      inp.addEventListener("change", handler);
    });
    inspector.querySelector('[data-act="move-up"]').onclick = () => {
      const i = model.blocks.indexOf(b);
      if (i > 0) { [model.blocks[i-1], model.blocks[i]] = [model.blocks[i], model.blocks[i-1]]; render(); selectBlock(b.id); }
    };
    inspector.querySelector('[data-act="move-down"]').onclick = () => {
      const i = model.blocks.indexOf(b);
      if (i < model.blocks.length - 1) { [model.blocks[i+1], model.blocks[i]] = [model.blocks[i], model.blocks[i+1]]; render(); selectBlock(b.id); }
    };
    inspector.querySelector('[data-act="delete"]').onclick = () => {
      model.blocks = model.blocks.filter((x) => x.id !== b.id);
      selectedId = null;
      render();
    };
  }

  async function wireCollabUI() {
    const listEl = inspector.querySelector('[data-bind="collab-list"]');
    const addBtn = inspector.querySelector('[data-act="add-collab"]');
    const addIn  = inspector.querySelector('[data-bind="collab-add"]');
    if (!listEl) return;
    const marker = await FS.read(currentProject + "/.blizzard-domain");
    const projName = marker?.content || currentProject?.split("/").pop()?.toLowerCase();
    const site = projName ? await getSite(projName) : null;
    if (!site) {
      listEl.innerHTML = `<div class="muted" style="font-size:11.5px">(Publish this site first to invite collaborators.)</div>`;
      return;
    }
    const ids = Object.keys(site.collaborators || {});
    if (ids.length === 0) listEl.innerHTML = `<div class="muted" style="font-size:11.5px">No collaborators yet.</div>`;
    else {
      const names = await Promise.all(ids.map(async (u) => (await loadUser(u))?.username || u));
      listEl.innerHTML = ids.map((uid, i) => `
        <div class="builder-collab">
          <span>@${escapeHtml(names[i])}</span>
          <button class="remove" data-uid="${escapeHtml(uid)}">×</button>
        </div>
      `).join("");
      listEl.querySelectorAll(".remove").forEach((b) => b.addEventListener("click", async () => {
        await removeCollaborator(projName, b.dataset.uid);
        wireCollabUI();
      }));
    }
    addBtn.onclick = async () => {
      const u = addIn.value.trim();
      if (!u) return;
      const uid = await lookupUidByUsername(u);
      if (!uid) { alert("No such user."); return; }
      if (uid === ctx.user.uid) { alert("You're the owner already."); return; }
      await addCollaborator(projName, uid);
      addIn.value = "";
      wireCollabUI();
    };
  }

  // Palette drag-and-drop
  root.querySelectorAll(".builder-tool").forEach((tool) => {
    tool.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/builder-type", tool.dataset.type);
    });
  });

  canvas.addEventListener("dragover", (e) => { e.preventDefault(); });
  canvas.addEventListener("drop", (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData("text/builder-type");
    if (!type) return;
    const tpl = PALETTE.find((p) => p.type === type);
    const block = { id: uid(), type, ...tpl.defaults };
    model.blocks.push(block);
    selectedId = block.id;
    render();
  });
  canvas.addEventListener("click", () => { selectedId = null; render(); });

  titleIn.addEventListener("input", () => { model.title = titleIn.value; });
  themeIn.addEventListener("change", () => { model.theme = themeIn.value; render(); });

  function modelToHtml(model) {
    const body = model.blocks.map((b) => {
      switch (b.type) {
        case "heading": return `<${b.level || "h1"}>${escapeHtml(b.text || "")}</${b.level || "h1"}>`;
        case "text":    return `<p>${escapeHtml(b.text || "")}</p>`;
        case "button":  return `<p><a class="btn" href="${escapeHtml(b.href || "#")}">${escapeHtml(b.text || "Button")}</a></p>`;
        case "image":   return b.src ? `<p><img src="${escapeHtml(b.src)}" alt="${escapeHtml(b.alt || "")}" /></p>` : "";
        case "spacer":  return `<div style="height:${parseInt(b.height || 24, 10)}px"></div>`;
        case "divider": return `<hr>`;
        default: return "";
      }
    }).join("\n  ");

    const css = model.theme === "dark"
      ? `body{background:#0b1220;color:#eaf2ff;font-family:system-ui,sans-serif;margin:0;padding:40px;max-width:760px;margin:0 auto}
         a.btn{display:inline-block;padding:8px 14px;background:#5aa9ff;color:#fff;border-radius:6px;text-decoration:none}
         img{max-width:100%}`
      : `body{background:#fff;color:#111;font-family:system-ui,sans-serif;margin:0;padding:40px;max-width:760px;margin:0 auto}
         a.btn{display:inline-block;padding:8px 14px;background:#5aa9ff;color:#fff;border-radius:6px;text-decoration:none}
         img{max-width:100%}`;

    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(model.title || "Site")}</title>
  <style>${css}</style>
</head>
<body>
  ${body}
</body>
</html>`;
  }

  async function save() {
    if (!currentProject) { alert("Pick or create a project first."); return; }
    const html = modelToHtml(model);
    const json = JSON.stringify(model, null, 2);

    if (currentProject.startsWith("shared:")) {
      const domain = currentProject.slice(7);
      const site = await getSite(domain);
      if (!site) { alert("Site not found."); return; }
      const files = { ...(site.files || {}), "index.html": html, "_builder.json": json };
      try {
        await publishSite(domain, ctx.user.uid, files, site.description || "");
        statusEl.textContent = "Saved (shared) ✓";
      } catch (e) {
        alert("Save failed: " + e.message);
      }
    } else {
      await FS.write(currentProject + "/index.html", html);
      await FS.write(currentProject + "/_builder.json", json);
      statusEl.textContent = "Saved ✓";
    }
    setTimeout(() => { statusEl.textContent = ""; }, 1800);
  }

  async function publish() {
    if (!currentProject) return;
    if (currentProject.startsWith("shared:")) {
      await save();
      return;
    }
    const projName = currentProject.split("/").pop().toLowerCase();
    const domain = prompt(`Publish as which blizz:// domain?\n(e.g. ${projName}.com, ${projName}.blz)`, projName + ".com");
    if (!domain) return;
    if (!/^[a-z0-9_-]{2,30}\.[a-z]{2,10}$/.test(domain)) {
      alert("Domain must be like name.tld — e.g. mysite.com, cool.blz");
      return;
    }
    const description = prompt("One-line description (optional):") || "";
    await save();
    const html = modelToHtml(model);
    const json = JSON.stringify(model, null, 2);
    try {
      await publishSite(domain, ctx.user.uid, { "index.html": html, "_builder.json": json }, description);
      await FS.write(currentProject + "/.blizzard-domain", domain);
      alert("Published! Open Blizzard browser → blizz://" + domain);
      wireCollabUI();
    } catch (e) {
      alert("Publish failed: " + e.message);
    }
  }

  root.querySelector('[data-act="save"]').addEventListener("click", save);
  root.querySelector('[data-act="publish"]').addEventListener("click", publish);
  root.querySelector('[data-act="new-proj"]').addEventListener("click", async () => {
    const name = prompt("Site name (becomes folder + default domain):");
    if (!name) return;
    const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const path = "/Projects/" + safe;
    if (await FS.exists(path)) { alert("That project already exists."); return; }
    await FS.write(path + "/index.html", "");
    currentProject = path;
    model = newDoc();
    model.title = name;
    selectedId = null;
    await refreshProjectList();
    render();
  });
  projSel.addEventListener("change", async () => {
    currentProject = projSel.value;
    selectedId = null;
    await loadCurrent();
  });

  await refreshProjectList();
  await loadCurrent();
}
