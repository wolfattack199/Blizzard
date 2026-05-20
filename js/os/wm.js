// Window manager — open, focus, drag, resize, minimize, maximize, close.

const layer = () => document.getElementById("windows");
const tpl = () => document.getElementById("tpl-window");

let zCounter = 100;
let cascadeOffset = 0;
let instanceCounter = 0;
const windows = new Map(); // unique id -> { id, appId, el, title, glyph, state }
const listeners = new Set();

export function onWindowsChanged(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit() { listeners.forEach((cb) => cb([...windows.values()])); }

export function getWindows() { return [...windows.values()]; }

export function openWindow({ id, title, glyph, render, width = 720, height = 480, singleton = false }) {
  // `id` here is the app id (e.g. "messenger"). If singleton, we reuse the
  // existing window. Otherwise we give every instance a unique id so the
  // user can open as many as they want.
  const appId = id;
  let uniqueId;
  if (singleton) {
    if (windows.has(appId)) {
      focusWindow(appId);
      restore(appId);
      return windows.get(appId);
    }
    uniqueId = appId;
  } else {
    uniqueId = `${appId}#${++instanceCounter}`;
  }

  const node = tpl().content.firstElementChild.cloneNode(true);
  node.dataset.id = uniqueId;
  node.dataset.appId = appId;
  node.querySelector(".window-title").textContent = title;
  node.querySelector(".window-icon").textContent = glyph || "📦";

  const body = node.querySelector(".window-body");

  // Initial size + cascading position
  const maxW = layer().clientWidth;
  const maxH = layer().clientHeight;
  width = Math.min(width, maxW - 40);
  height = Math.min(height, maxH - 40);
  const left = Math.min(60 + cascadeOffset, maxW - width - 20);
  const top = Math.min(40 + cascadeOffset, maxH - height - 20);
  cascadeOffset = (cascadeOffset + 28) % 200;

  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
  node.style.width = `${width}px`;
  node.style.height = `${height}px`;
  node.style.zIndex = String(++zCounter);

  layer().appendChild(node);
  requestAnimationFrame(() => node.classList.add("open"));

  const win = { id: uniqueId, appId, el: node, title, glyph, state: { minimized: false, maximized: false, prevRect: null }, app: null };
  windows.set(uniqueId, win);

  // Wire chrome
  node.querySelector(".win-close").addEventListener("click", (e) => { e.stopPropagation(); closeWindow(uniqueId); });
  node.querySelector(".win-min").addEventListener("click", (e) => { e.stopPropagation(); minimize(uniqueId); });
  node.querySelector(".win-max").addEventListener("click", (e) => { e.stopPropagation(); toggleMaximize(uniqueId); });

  // Focus on mousedown
  node.addEventListener("mousedown", () => focusWindow(uniqueId));

  // Drag
  const titlebar = node.querySelector(".window-titlebar");
  titlebar.addEventListener("dblclick", () => toggleMaximize(uniqueId));
  titlebar.addEventListener("mousedown", (e) => startDrag(uniqueId, e));

  // Resize
  node.querySelector(".window-resize").addEventListener("mousedown", (e) => startResize(uniqueId, e));

  focusWindow(uniqueId);

  // Render app
  try {
    const apiBody = { root: body, win };
    const cleanup = render(apiBody);
    win.cleanup = typeof cleanup === "function" ? cleanup : null;
  } catch (err) {
    body.innerHTML = `<div style="padding:20px;color:#ff6b7a">Failed to load app: ${escapeHtml(err.message)}</div>`;
    console.error(err);
  }

  emit();
  return win;
}

export function closeWindow(id) {
  const w = windows.get(id);
  if (!w) return;
  if (w.cleanup) try { w.cleanup(); } catch {}
  w.el.classList.remove("open");
  setTimeout(() => w.el.remove(), 140);
  windows.delete(id);
  emit();
}

export function focusWindow(id) {
  const w = windows.get(id);
  if (!w) return;
  w.el.style.zIndex = String(++zCounter);
  for (const other of windows.values()) other.el.classList.toggle("focused", other === w);
}

export function minimize(id) {
  const w = windows.get(id);
  if (!w) return;
  w.el.classList.add("minimized");
  w.state.minimized = true;
  emit();
}

export function restore(id) {
  const w = windows.get(id);
  if (!w) return;
  if (w.state.minimized) {
    w.el.classList.remove("minimized");
    w.state.minimized = false;
  }
  focusWindow(id);
  emit();
}

export function toggleTaskbar(id) {
  const w = windows.get(id);
  if (!w) return;
  if (w.state.minimized) restore(id);
  else if (w.el.classList.contains("focused")) minimize(id);
  else { restore(id); focusWindow(id); }
}

export function toggleMaximize(id) {
  const w = windows.get(id);
  if (!w) return;
  if (w.state.maximized) {
    w.el.classList.remove("maximized");
    const r = w.state.prevRect;
    if (r) {
      w.el.style.left = r.left + "px";
      w.el.style.top = r.top + "px";
      w.el.style.width = r.width + "px";
      w.el.style.height = r.height + "px";
    }
    w.state.maximized = false;
  } else {
    const r = w.el.getBoundingClientRect();
    const lr = layer().getBoundingClientRect();
    w.state.prevRect = {
      left: parseInt(w.el.style.left, 10),
      top: parseInt(w.el.style.top, 10),
      width: r.width, height: r.height
    };
    w.el.classList.add("maximized");
    w.el.style.left = "0px";
    w.el.style.top = "0px";
    w.el.style.width = lr.width + "px";
    w.el.style.height = lr.height + "px";
    w.state.maximized = true;
  }
}

function startDrag(id, e) {
  const w = windows.get(id);
  if (!w || w.state.maximized) return;
  if (e.target.closest(".win-btn")) return;
  e.preventDefault();
  focusWindow(id);
  w.el.classList.add("dragging");
  const startX = e.clientX, startY = e.clientY;
  const startLeft = parseInt(w.el.style.left, 10);
  const startTop = parseInt(w.el.style.top, 10);
  const lr = layer().getBoundingClientRect();

  function move(ev) {
    const nx = Math.max(-50, Math.min(lr.width - 80, startLeft + (ev.clientX - startX)));
    const ny = Math.max(0, Math.min(lr.height - 30, startTop + (ev.clientY - startY)));
    w.el.style.left = nx + "px";
    w.el.style.top = ny + "px";
  }
  function up() {
    w.el.classList.remove("dragging");
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
  }
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

function startResize(id, e) {
  const w = windows.get(id);
  if (!w || w.state.maximized) return;
  e.preventDefault();
  focusWindow(id);
  const startX = e.clientX, startY = e.clientY;
  const startW = w.el.offsetWidth;
  const startH = w.el.offsetHeight;
  function move(ev) {
    w.el.style.width = Math.max(280, startW + (ev.clientX - startX)) + "px";
    w.el.style.height = Math.max(180, startH + (ev.clientY - startY)) + "px";
  }
  function up() {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
  }
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[c]));
}

export function closeAllWindows() {
  for (const id of [...windows.keys()]) closeWindow(id);
}
