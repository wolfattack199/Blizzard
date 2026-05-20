// Blizzard Studios — IDE: file tree (per project), editor tabs, live preview.
// Projects can live anywhere: /Projects/<name>/ (local) or /Cloud/My Files/Projects/<name>/ (synced).
// "Open folder" lets users pick ANY folder as the current working project.
import * as FS from "../fs.js";
import { escapeHtml } from "../os/wm.js";
import { publishSite } from "../firebase.js";
import { pickFolder } from "../os/folderpicker.js";

const CLOUD_PROJECTS = "/Cloud/My Files/Projects";
const LAST_PROJECT_KEY = "blizzard.studios.lastProject";

export async function mountStudios(root, ctx) {
  root.innerHTML = `
    <div class="app studios-app">
      <div class="app-toolbar studios-toolbar">
        <button data-act="open-folder" title="Open any folder as a project">📂 Open folder…</button>
        <button data-act="new-project">＋ New project</button>
        <button data-act="new-file">＋ New file</button>
        <button data-act="save" title="Save (Ctrl+S)">💾 Save</button>
        <button data-act="run-html" title="Run current file in Blizzard browser tab">▶ Run in browser</button>
        <button data-act="run" title="Inline preview pane">⌖ Preview</button>
        <button class="primary" data-act="publish">⬆ Publish</button>
        <span class="grow"></span>
        <span class="muted" data-bind="path"></span>
      </div>
      <div class="studios">
        <div class="studios-activity">
          <div class="studios-activity-item active" data-view="explorer" title="Explorer">📁</div>
          <div class="studios-activity-item" data-view="search" title="Search">🔍</div>
          <div class="studios-activity-item" data-view="git" title="Source control">⎇</div>
          <div class="studios-activity-item" data-view="run" title="Run">▶</div>
          <div class="studios-activity-item" data-view="ext" title="Extensions">🧩</div>
        </div>
        <div class="studios-side">
          <div class="studios-projects">
            <span class="muted" style="font-size:10.5px;letter-spacing:0.6px;text-transform:uppercase;display:block;margin-bottom:4px">Project</span>
            <select data-bind="proj-select"></select>
          </div>
          <div class="studios-side-head">
            Explorer
            <button style="padding:2px 6px;font-size:11px" data-act="new-file-side">+</button>
          </div>
          <div class="studios-tree" data-bind="tree"></div>
        </div>
        <div class="studios-main">
          <div class="studios-tabs" data-bind="tabs"></div>
          <div style="flex:1; display:flex; min-height:0;">
            <textarea class="studios-editor" spellcheck="false" data-bind="editor" placeholder="Open a file from the explorer to start coding…"></textarea>
            <div class="studios-preview" data-bind="preview" style="display:none;">
              <iframe sandbox="allow-scripts"></iframe>
            </div>
          </div>
          <div class="studios-status">
            <span data-bind="status">Ready</span>
            <span class="grow" style="flex:1"></span>
            <span data-bind="encoding" style="margin-right:8px">UTF-8</span>
            <span data-bind="lang" style="margin-right:8px">Plain</span>
            <span data-bind="line-info">Ln 1, Col 1</span>
          </div>
        </div>
      </div>
    </div>
  `;

  const projSelect = root.querySelector('[data-bind="proj-select"]');
  const tree       = root.querySelector('[data-bind="tree"]');
  const tabs       = root.querySelector('[data-bind="tabs"]');
  const editor     = root.querySelector('[data-bind="editor"]');
  const previewBox = root.querySelector('[data-bind="preview"]');
  const status     = root.querySelector('[data-bind="status"]');
  const pathLabel  = root.querySelector('[data-bind="path"]');
  const lineInfo   = root.querySelector('[data-bind="line-info"]');

  let currentProject = null;     // e.g. "/Projects/MySite"
  let openTabs = [];             // [{ path, dirty }]
  let activePath = null;

  await ensureProjectsExist();

  async function ensureProjectsExist() {
    const exists = await FS.exists("/Projects");
    if (!exists) await FS.mkdir("/Projects");
    // If no projects, create a sample one
    const items = await FS.list("/Projects");
    if (items.length === 0) {
      await FS.write("/Projects/hello/index.html",
`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Hello</title><link rel="stylesheet" href="style.css"></head>
<body>
  <h1>Hello, Blizzard!</h1>
  <p>Edit me in Blizzard Studios, then click Publish.</p>
  <script src="app.js"></script>
</body>
</html>`);
      await FS.write("/Projects/hello/style.css",
`body { font-family: system-ui, sans-serif; padding: 40px; background: #0b1220; color: #eaf2ff; }
h1 { color: #7cc7ff; }`);
      await FS.write("/Projects/hello/app.js",
`console.log("Hello from Blizzard Studios!");`);
    }
  }

  async function refreshProjectsList() {
    const localProjects = (await FS.list("/Projects").catch(() => [])).filter((f) => f.isDir);
    let cloudProjects = [];
    try {
      if (await FS.exists(CLOUD_PROJECTS)) {
        cloudProjects = (await FS.list(CLOUD_PROJECTS)).filter((f) => f.isDir);
      }
    } catch {}

    let options = "";
    if (cloudProjects.length) {
      options += `<optgroup label="☁ Cloud (synced)">${cloudProjects.map((p) =>
        `<option value="${escapeHtml(p.path)}">${escapeHtml(p.name)}</option>`).join("")}</optgroup>`;
    }
    if (localProjects.length) {
      options += `<optgroup label="💾 This device">${localProjects.map((p) =>
        `<option value="${escapeHtml(p.path)}">${escapeHtml(p.name)}</option>`).join("")}</optgroup>`;
    }
    const isKnown = (path) => cloudProjects.find((p) => p.path === path) || localProjects.find((p) => p.path === path);
    if (currentProject && !isKnown(currentProject)) {
      options = `<optgroup label="📂 Open folder"><option value="${escapeHtml(currentProject)}">${escapeHtml(currentProject)}</option></optgroup>` + options;
    }
    projSelect.innerHTML = options || `<option value="">(no projects)</option>`;
    if (!currentProject || !projSelect.querySelector(`option[value="${cssEscape(currentProject)}"]`)) {
      currentProject = cloudProjects[0]?.path || localProjects[0]?.path || currentProject || null;
    }
    if (currentProject) {
      projSelect.value = currentProject;
      localStorage.setItem(LAST_PROJECT_KEY + "." + ctx.user.uid, currentProject);
    }
  }
  function cssEscape(s) { return String(s).replace(/[\\"']/g, (c) => "\\" + c); }

  async function refreshTree() {
    if (!currentProject) {
      tree.innerHTML = `<div class="studios-tree-empty">No projects. Click "New project".</div>`;
      return;
    }
    const files = (await FS.list(currentProject, { recursive: true }))
      .filter((f) => !f.isDir && f.name !== ".keep")
      .sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) {
      tree.innerHTML = `<div class="studios-tree-empty">Empty project.</div>`;
      return;
    }
    tree.innerHTML = files.map((f) => `
      <div class="studios-tree-item${f.path === activePath ? " active" : ""}" data-path="${escapeHtml(f.path)}">
        <span>${FS.fileIcon(f)}</span>
        <span>${escapeHtml(f.path.slice(currentProject.length + 1))}</span>
      </div>
    `).join("");
    tree.querySelectorAll(".studios-tree-item").forEach((el) =>
      el.addEventListener("click", () => openFile(el.dataset.path))
    );
  }

  function refreshTabs() {
    tabs.innerHTML = openTabs.map((t) => `
      <div class="studios-tab${t.path === activePath ? " active" : ""}" data-path="${escapeHtml(t.path)}">
        <span>${escapeHtml(t.path.split("/").pop())}${t.dirty ? " •" : ""}</span>
        <span class="studios-tab-close" data-close="${escapeHtml(t.path)}">×</span>
      </div>
    `).join("");
    tabs.querySelectorAll(".studios-tab").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("studios-tab-close")) {
          closeTab(e.target.dataset.close);
        } else {
          openFile(el.dataset.path);
        }
      });
    });
  }

  async function openFile(path) {
    if (!openTabs.find((t) => t.path === path)) {
      openTabs.push({ path, dirty: false });
    }
    activePath = path;
    const rec = await FS.read(path);
    editor.value = rec?.content || "";
    pathLabel.textContent = path;
    refreshTree();
    refreshTabs();
    updateLineInfo();
  }

  function closeTab(path) {
    const tab = openTabs.find((t) => t.path === path);
    if (tab?.dirty && !confirm("Discard unsaved changes?")) return;
    openTabs = openTabs.filter((t) => t.path !== path);
    if (activePath === path) {
      activePath = openTabs[openTabs.length - 1]?.path || null;
      if (activePath) openFile(activePath);
      else { editor.value = ""; pathLabel.textContent = ""; }
    }
    refreshTabs();
  }

  let autoSaveTimer = null;
  editor.addEventListener("input", () => {
    const t = openTabs.find((x) => x.path === activePath);
    if (t) { t.dirty = true; refreshTabs(); }
    status.textContent = "Modified";
    updateLineInfo();
    // Debounced auto-save (1s after typing stops).
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      saveCurrent().then(() => {
        status.textContent = "Auto-saved ✓";
        setTimeout(() => { if (status.textContent === "Auto-saved ✓") status.textContent = "Ready"; }, 1200);
      }).catch(() => {});
    }, 1000);
  });

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = editor.selectionStart, e2 = editor.selectionEnd;
      editor.value = editor.value.slice(0, s) + "  " + editor.value.slice(e2);
      editor.selectionStart = editor.selectionEnd = s + 2;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCurrent();
    }
    updateLineInfo();
  });
  editor.addEventListener("click", updateLineInfo);

  function updateLineInfo() {
    const v = editor.value.slice(0, editor.selectionStart);
    const line = v.split("\n").length;
    const col = v.length - v.lastIndexOf("\n");
    lineInfo.textContent = `Ln ${line}, Col ${col}`;
    const langEl = root.querySelector('[data-bind="lang"]');
    if (langEl) langEl.textContent = languageOf(activePath);
  }
  function languageOf(p) {
    if (!p) return "Plain";
    const ext = (p.split(".").pop() || "").toLowerCase();
    return {
      html: "HTML", htm: "HTML", css: "CSS", js: "JavaScript",
      json: "JSON", md: "Markdown", txt: "Plain", blz: "HTML",
      ts: "TypeScript", py: "Python", svg: "SVG"
    }[ext] || "Plain";
  }

  async function saveCurrent() {
    if (!activePath) return;
    await FS.write(activePath, editor.value);
    const t = openTabs.find((x) => x.path === activePath);
    if (t) t.dirty = false;
    refreshTabs();
    status.textContent = "Saved";
    setTimeout(() => { status.textContent = "Ready"; }, 1500);
  }

  async function runPreview() {
    if (!currentProject) return;
    const files = (await FS.list(currentProject, { recursive: true }))
      .filter((f) => !f.isDir && f.name !== ".keep");
    const map = {};
    for (const f of files) {
      const rec = await FS.read(f.path);
      map[f.path.slice(currentProject.length + 1)] = rec?.content || "";
    }
    const indexHtml = map["index.html"];
    if (!indexHtml) { alert("No index.html in this project."); return; }
    const merged = indexHtml
      .replace(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/gi, (m, name) =>
        map[name] ? `<style>${map[name]}</style>` : m)
      .replace(/<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/gi, (m, name) =>
        map[name] ? `<script>${map[name]}<\/script>` : m);
    previewBox.style.display = "block";
    previewBox.querySelector("iframe").srcdoc = merged;
  }

  async function publishProject() {
    if (!currentProject) return;
    const projName = currentProject.split("/").pop();
    const defaultDomain = projName.toLowerCase() + ".com";
    const domain = prompt(`Publish "${projName}" as which blizz:// domain?\n(e.g. ${projName.toLowerCase()}.com, ${projName.toLowerCase()}.blz)`, defaultDomain);
    if (!domain) return;
    if (!/^[a-z0-9_-]{2,30}\.[a-z]{2,10}$/.test(domain)) {
      alert("Domain must be like name.tld — e.g. mysite.com, cool.blz, my-app.ice.");
      return;
    }
    const description = prompt("One-line description (optional):") || "";

    const files = (await FS.list(currentProject, { recursive: true }))
      .filter((f) => !f.isDir && f.name !== ".keep");
    const fileMap = {};
    for (const f of files) {
      const rec = await FS.read(f.path);
      fileMap[f.path.slice(currentProject.length + 1)] = rec?.content || "";
    }

    try {
      await publishSite(domain, ctx.user.uid, fileMap, description);
      await FS.write(currentProject + "/.blizzard-domain", domain);
      status.textContent = `Published to blizz://${domain}`;
      alert(`Published! Open Blizzard browser and visit blizz://${domain}`);
    } catch (e) {
      alert("Publish failed: " + e.message);
    }
  }

  root.querySelector('[data-act="save"]').addEventListener("click", saveCurrent);
  root.querySelector('[data-act="run"]').addEventListener("click", runPreview);
  root.querySelector('[data-act="run-html"]').addEventListener("click", runInBrowserTab);
  root.querySelector('[data-act="publish"]').addEventListener("click", publishProject);

  async function runInBrowserTab() {
    if (!activePath || !/\.(html|htm|blz)$/i.test(activePath)) {
      alert("Open an .html (or .blz) file first, then click Run in browser.");
      return;
    }
    // Save first so the file on disk matches what we run.
    await saveCurrent();
    // Inline same-project CSS/JS so the page works standalone in the tab.
    const projDir = currentProject || activePath.split("/").slice(0, -1).join("/");
    const files = (await FS.list(projDir, { recursive: true })).filter((f) => !f.isDir && f.name !== ".keep");
    const map = {};
    for (const f of files) {
      const rec = await FS.read(f.path);
      map[f.path.slice(projDir.length + 1)] = rec?.content || "";
    }
    const baseName = activePath.slice(projDir.length + 1);
    const html = (map[baseName] || "")
      .replace(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/gi, (m, name) =>
        map[name] ? `<style>${map[name]}</style>` : m)
      .replace(/<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/gi, (m, name) =>
        map[name] ? `<script>${map[name]}<\/script>` : m);
    ctx.launchApp("browser", { initialHtml: html, initialTitle: activePath.split("/").pop() });
  }
  root.querySelector('[data-act="new-project"]').addEventListener("click", async () => {
    const name = prompt("Project name? (saves to your synced Cloud Projects folder)");
    if (!name) return;
    // Default new projects to /Cloud/My Files/Projects/<name>/ so they sync
    // across devices automatically.
    const safe = name.replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "untitled";
    const path = CLOUD_PROJECTS + "/" + safe;
    if (await FS.exists(path + "/index.html")) { alert("That project already exists."); return; }
    await FS.write(path + "/index.html",
`<!doctype html><html><body><h1>${escapeHtml(name)}</h1></body></html>`);
    currentProject = path;
    localStorage.setItem(LAST_PROJECT_KEY + "." + ctx.user.uid, currentProject);
    await refreshProjectsList();
    await refreshTree();
    openFile(path + "/index.html");
  });

  root.querySelector('[data-act="open-folder"]').addEventListener("click", async () => {
    const picked = await pickFolder({
      title: "Open folder as project",
      initialPath: currentProject || CLOUD_PROJECTS
    });
    if (!picked) return;
    currentProject = picked;
    localStorage.setItem(LAST_PROJECT_KEY + "." + ctx.user.uid, currentProject);
    openTabs = [];
    activePath = null;
    editor.value = "";
    pathLabel.textContent = "";
    await refreshProjectsList();
    await refreshTree();
    // Auto-open an obvious entry file if present.
    for (const candidate of ["index.html", "main.html", "app.js", "main.py", "README.md"]) {
      if (await FS.exists(currentProject + "/" + candidate)) {
        openFile(currentProject + "/" + candidate);
        break;
      }
    }
  });
  async function newFileFlow() {
    if (!currentProject) { alert("Pick or create a project first."); return; }
    const name = prompt("File name (e.g. about.html, app.js, style.css, notes.md):");
    if (!name) return;
    await FS.write(currentProject + "/" + name, "");
    await refreshTree();
    openFile(currentProject + "/" + name);
  }
  root.querySelector('[data-act="new-file"]').addEventListener("click", newFileFlow);
  root.querySelector('[data-act="new-file-side"]').addEventListener("click", newFileFlow);
  projSelect.addEventListener("change", async () => {
    currentProject = projSelect.value;
    localStorage.setItem(LAST_PROJECT_KEY + "." + ctx.user.uid, currentProject);
    openTabs = [];
    activePath = null;
    editor.value = "";
    pathLabel.textContent = "";
    await refreshTree();
  });

  // If launched with an initialPath, set up Studios to point at that file.
  // - Path under /Projects/<name>/... → that project, open the file.
  // - Path under /Cloud/My Files/Projects/<name>/... → that synced project.
  // - Elsewhere → use the parent folder as a "session" project so the user
  //   can still see sibling .html / .js / .css files in the explorer.
  if (ctx.initialPath && await FS.exists(ctx.initialPath)) {
    const ip = FS.normalize(ctx.initialPath);
    const m1 = ip.match(/^\/Projects\/[^/]+/);
    const m2 = ip.match(/^\/Cloud\/My Files\/Projects\/[^/]+/);
    currentProject = m1?.[0] || m2?.[0] || ip.split("/").slice(0, -1).join("/");
    localStorage.setItem(LAST_PROJECT_KEY + "." + ctx.user.uid, currentProject);
  } else {
    // Restore the last opened project from a previous Studios session.
    const last = localStorage.getItem(LAST_PROJECT_KEY + "." + ctx.user.uid);
    if (last && await FS.exists(last)) currentProject = last;
  }

  await refreshProjectsList();
  await refreshTree();

  if (ctx.initialPath && await FS.exists(ctx.initialPath)) {
    openFile(ctx.initialPath);
  } else {
    const indexPath = currentProject ? currentProject + "/index.html" : null;
    if (indexPath && await FS.exists(indexPath)) openFile(indexPath);
  }
}
