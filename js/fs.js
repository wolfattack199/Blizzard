// Per-user virtual file system. Dual-backend:
//   • paths starting with /Cloud/  → Firebase (synced across devices)
//   • everything else              → IndexedDB (local to this device)
//
// Paths are POSIX-style ("/Documents/notes.txt"). Folders are implicit:
// they exist if any file's path is prefixed by "<folder>/".

import {
  subscribeCloudFiles, subscribeCloudFolders, subscribeCloudShares,
  cloudUploadAt, cloudWriteText, cloudMkdir,
  cloudGetBlob, cloudGetFile, cloudDeleteFile, cloudDeleteFolder, cloudRenameFile, cloudRenameFolder,
  cloudShareFile, cloudUnshareFile
} from "./firebase.js";

const DB_NAME_PREFIX = "BlizzardFS_";
const STORE = "files";

export const CLOUD_ROOT   = "/Cloud";
export const CLOUD_MINE   = "/Cloud/My Files";
export const CLOUD_SHARED = "/Cloud/Shared with me";

let openDbPromise = null;
let currentUid = null;
let currentDb = null;
const subscribers = new Set();

// Cloud caches, kept fresh by Firebase subscriptions
let cloudFiles   = [];   // owner files: [{ id, path, parent, name, size, type, uploadedAt, ownerUid, sharedWith }]
let cloudFolders = [];   // [path,...]
let cloudShares  = [];   // [{ ownerUid, ownerUsername, fid, name, size, type, sharedAt }]
let unsubCloud = [];

function notify(change) {
  subscribers.forEach((cb) => { try { cb(change); } catch {} });
}
export function subscribeFS(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function openDb(uid) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME_PREFIX + uid, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "path" });
        os.createIndex("byParent", "parent");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function initFS(uid) {
  if (currentUid === uid && currentDb) return;
  currentUid = uid;
  openDbPromise = openDb(uid);
  currentDb = await openDbPromise;

  // Cloud subscriptions
  unsubCloud.forEach((u) => u());
  unsubCloud = [];
  unsubCloud.push(subscribeCloudFiles(uid, (files) => {
    cloudFiles = files;
    notify({ type: "cloud" });
  }));
  unsubCloud.push(subscribeCloudFolders(uid, (folders) => {
    cloudFolders = folders;
    notify({ type: "cloud" });
  }));
  unsubCloud.push(subscribeCloudShares(uid, (shares) => {
    cloudShares = shares;
    notify({ type: "cloud" });
  }));

  // Seed local folders + welcome
  const seeded = await readLocal("/.seed");
  if (!seeded) {
    await writeLocal("/.seed", "1", { hidden: true });
    await writeLocal("/Documents/Welcome.txt",
`Welcome to Blizzard OS.

This is your local file system. Everything you save here is stored on this
device (IndexedDB) and is private to your account.

To sync files across devices, save them under /Cloud — those go to your
Blizzard account in the cloud, and you can share them with other users.

Try:
  * Open "Blizzard Studios" to write code
  * Open "Site Builder" to design a website
  * Open "Terminal" and type: help
  * Browse new games in "Community Hub"
`);
    await writeLocal("/Pictures/.keep", "");
    await writeLocal("/Downloads/.keep", "");
    await writeLocal("/Projects/.keep", "");
  }
}

// ---------------------------------------------------------------------------
// Path utilities
// ---------------------------------------------------------------------------
export function normalize(path) {
  if (!path) return "/";
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/\/+/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}
function parentOf(path) {
  const p = normalize(path);
  if (p === "/") return null;
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}
function nameOf(path) {
  const p = normalize(path);
  if (p === "/") return "";
  return p.slice(p.lastIndexOf("/") + 1);
}

export function isCloudPath(p) {
  p = normalize(p);
  return p === CLOUD_ROOT || p.startsWith(CLOUD_ROOT + "/");
}
export function isSharedPath(p) {
  p = normalize(p);
  return p === CLOUD_SHARED || p.startsWith(CLOUD_SHARED + "/");
}
export function isMyCloudPath(p) {
  p = normalize(p);
  return (p === CLOUD_MINE || p.startsWith(CLOUD_MINE + "/")) ||
         (isCloudPath(p) && !isSharedPath(p) && p !== CLOUD_ROOT);
}

// ---------------------------------------------------------------------------
// LOCAL backend (IndexedDB)
// ---------------------------------------------------------------------------
function tx(mode = "readonly") {
  return currentDb.transaction(STORE, mode).objectStore(STORE);
}
function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function writeLocal(path, content, meta = {}) {
  path = normalize(path);
  const record = {
    path, parent: parentOf(path), name: nameOf(path),
    content: content ?? "",
    type: meta.type || guessType(path),
    hidden: !!meta.hidden,
    modified: Date.now()
  };
  await req(tx("readwrite").put(record));
  notify({ type: "write", path });
  return record;
}
async function readLocal(path) {
  return req(tx().get(normalize(path)));
}
async function removeLocal(path) {
  path = normalize(path);
  const rec = await readLocal(path);
  if (rec) {
    await req(tx("readwrite").delete(path));
  } else {
    const all = await listLocalAll();
    const store = tx("readwrite");
    for (const f of all) if (f.path === path || f.path.startsWith(path + "/")) store.delete(f.path);
  }
  notify({ type: "remove", path });
}
async function listLocalAll() {
  const out = [];
  const store = tx();
  return new Promise((resolve, reject) => {
    const r = store.openCursor();
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const c = r.result;
      if (c) { out.push(c.value); c.continue(); }
      else resolve(out);
    };
  });
}
async function renameLocal(oldPath, newPath) {
  const all = await listLocalAll();
  const affected = all.filter((f) => f.path === oldPath || f.path.startsWith(oldPath + "/"));
  const store = tx("readwrite");
  for (const f of affected) {
    const np = newPath + f.path.slice(oldPath.length);
    store.delete(f.path);
    store.put({ ...f, path: np, parent: parentOf(np), name: nameOf(np), modified: Date.now() });
  }
  notify({ type: "rename", from: oldPath, to: newPath });
}

// ---------------------------------------------------------------------------
// CLOUD backend helpers
// ---------------------------------------------------------------------------
function dirChildrenCloud(dir, includeHidden) {
  dir = normalize(dir);
  const prefix = dir === "/" ? "/" : dir + "/";

  if (dir === CLOUD_ROOT) {
    return [
      { path: CLOUD_MINE,   parent: CLOUD_ROOT, name: "My Files",       isDir: true, type: "folder", modified: 0, cloud: true },
      { path: CLOUD_SHARED, parent: CLOUD_ROOT, name: "Shared with me", isDir: true, type: "folder", modified: 0, cloud: true }
    ];
  }

  if (isSharedPath(dir)) {
    if (dir !== CLOUD_SHARED) return [];   // no subfolders inside shares (flat)
    return cloudShares.map((s) => ({
      path: CLOUD_SHARED + "/" + s.ownerUsername + "__" + s.name,
      parent: CLOUD_SHARED,
      name: s.ownerUsername + " · " + s.name,
      isDir: false,
      type: guessTypeFromMime(s.type, s.name),
      modified: s.sharedAt || 0,
      size: s.size,
      cloud: true, shared: true,
      ownerUid: s.ownerUid, ownerUsername: s.ownerUsername, fid: s.fid
    }));
  }

  // /Cloud/My Files/... -> map to user's cloud files
  const ownDir = dir === CLOUD_MINE ? "/" : dir.slice(CLOUD_MINE.length);
  const ownPrefix = ownDir === "/" ? "/" : ownDir + "/";

  const direct = [];
  const folderSet = new Set();
  for (const f of cloudFiles) {
    // f.path is like "/Photos/cat.jpg" (relative to cloud root)
    if (!f.path) continue;
    if (!f.path.startsWith(ownPrefix) || f.path === ownDir) continue;
    const rest = f.path.slice(ownPrefix.length);
    if (rest.includes("/")) {
      folderSet.add(ownDir === "/" ? "/" + rest.split("/")[0] : ownDir + "/" + rest.split("/")[0]);
    } else {
      direct.push(f);
    }
  }
  for (const folderPath of cloudFolders) {
    if (folderPath === ownDir) continue;
    if (folderPath.startsWith(ownPrefix)) {
      const rest = folderPath.slice(ownPrefix.length);
      const first = rest.split("/")[0];
      folderSet.add(ownDir === "/" ? "/" + first : ownDir + "/" + first);
    }
  }

  const folders = [...folderSet].map((rel) => ({
    path: CLOUD_MINE + (rel.startsWith("/") ? rel : "/" + rel),
    parent: dir,
    name: rel.split("/").pop(),
    isDir: true,
    type: "folder",
    modified: 0,
    cloud: true
  }));

  const files = direct.map((f) => ({
    id: f.id,
    path: CLOUD_MINE + (f.path.startsWith("/") ? f.path : "/" + f.path),
    parent: dir,
    name: f.name,
    isDir: false,
    type: guessTypeFromMime(f.type, f.name),
    modified: f.uploadedAt || 0,
    size: f.size,
    cloud: true,
    shared: !!(f.sharedWith && Object.keys(f.sharedWith).length),
    fid: f.id,
    ownerUid: f.ownerUid,
    mime: f.type
  }));

  return [
    ...folders.sort((a, b) => a.name.localeCompare(b.name)),
    ...files.sort((a, b) => a.name.localeCompare(b.name))
  ];
}

function cloudOwnDirFromUiPath(uiPath) {
  // Convert "/Cloud/My Files/Photos" → "/Photos" (path used in cloud-files entries)
  if (uiPath === CLOUD_MINE) return "/";
  return uiPath.slice(CLOUD_MINE.length);
}

function findCloudFile(uiPath) {
  const ownPath = cloudOwnDirFromUiPath(uiPath);
  return cloudFiles.find((f) => f.path === ownPath);
}

function findCloudShare(uiPath) {
  // uiPath = "/Cloud/Shared with me/<owner>__<name>"
  if (!isSharedPath(uiPath) || uiPath === CLOUD_SHARED) return null;
  // Match by synthesized path
  for (const s of cloudShares) {
    const p = CLOUD_SHARED + "/" + s.ownerUsername + "__" + s.name;
    if (p === uiPath) return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API (auto-routed)
// ---------------------------------------------------------------------------
export async function write(path, content, meta = {}) {
  path = normalize(path);
  if (isSharedPath(path)) throw new Error("Shared files are read-only.");
  if (isCloudPath(path)) {
    if (path === CLOUD_ROOT || path === CLOUD_MINE) throw new Error("Pick a file name.");
    const ownPath = cloudOwnDirFromUiPath(path);
    await cloudWriteText(currentUid, ownPath, content || "");
    return { path };
  }
  return writeLocal(path, content, meta);
}

export async function read(path) {
  path = normalize(path);
  if (isSharedPath(path)) {
    const s = findCloudShare(path);
    if (!s) return null;
    const dataUrl = await cloudGetBlob(s.ownerUid, s.fid);
    return {
      path, name: s.name, type: guessTypeFromMime(s.type, s.name),
      content: dataUrl, mime: s.type, size: s.size, shared: true,
      ownerUsername: s.ownerUsername
    };
  }
  if (isCloudPath(path)) {
    const f = findCloudFile(path);
    if (!f) return null;
    const dataUrl = await cloudGetBlob(currentUid, f.id);
    return {
      path, name: f.name, type: guessTypeFromMime(f.type, f.name),
      content: dataUrl, mime: f.type, size: f.size,
      id: f.id, cloud: true
    };
  }
  return readLocal(path);
}

export async function exists(path) {
  path = normalize(path);
  if (isSharedPath(path)) return !!findCloudShare(path);
  if (isCloudPath(path)) {
    if (path === CLOUD_ROOT || path === CLOUD_MINE || path === CLOUD_SHARED) return true;
    if (findCloudFile(path)) return true;
    // folder existence
    const ownPath = cloudOwnDirFromUiPath(path);
    if (cloudFolders.includes(ownPath)) return true;
    if (cloudFiles.some((f) => (f.path || "").startsWith(ownPath + "/"))) return true;
    return false;
  }
  return !!(await readLocal(path));
}

export async function remove(path) {
  path = normalize(path);
  if (isSharedPath(path)) throw new Error("You can't delete shared files (only the owner can).");
  if (isCloudPath(path)) {
    const file = findCloudFile(path);
    if (file) {
      await cloudDeleteFile(currentUid, file.id);
      return;
    }
    // Treat as folder
    const ownPath = cloudOwnDirFromUiPath(path);
    await cloudDeleteFolder(currentUid, ownPath);
    return;
  }
  return removeLocal(path);
}

export async function rename(oldPath, newPath) {
  oldPath = normalize(oldPath);
  newPath = normalize(newPath);
  if (isSharedPath(oldPath) || isSharedPath(newPath)) throw new Error("Shared files can't be renamed here.");
  if (isCloudPath(oldPath) && isCloudPath(newPath)) {
    const file = findCloudFile(oldPath);
    if (file) {
      await cloudRenameFile(currentUid, file.id, nameOf(newPath));
      return;
    }
    // Treat as folder rename.
    const oldOwn = cloudOwnDirFromUiPath(oldPath);
    const newOwn = cloudOwnDirFromUiPath(newPath);
    await cloudRenameFolder(currentUid, oldOwn, newOwn);
    return;
  }
  if (isCloudPath(oldPath) !== isCloudPath(newPath)) {
    throw new Error("Use Save to copy between local and cloud.");
  }
  return renameLocal(oldPath, newPath);
}

export async function list(dir, { recursive = false, includeHidden = false } = {}) {
  dir = normalize(dir);

  if (isCloudPath(dir)) {
    if (recursive) {
      // simple non-recursive for cloud for now (folders rarely nest deeply here)
      return dirChildrenCloud(dir, includeHidden);
    }
    return dirChildrenCloud(dir, includeHidden);
  }

  // Local
  const all = await listLocalAll();
  const visible = all.filter((f) => includeHidden || !f.hidden);

  if (recursive) {
    return visible.filter((f) => f.path.startsWith(dir === "/" ? "/" : dir + "/") || f.path === dir);
  }

  const prefix = dir === "/" ? "/" : dir + "/";
  const directFiles = [];
  const folderSet = new Set();
  for (const f of visible) {
    if (!f.path.startsWith(prefix) || f.path === dir) continue;
    const rest = f.path.slice(prefix.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) directFiles.push(f);
    else folderSet.add(prefix + rest.slice(0, slashIdx));
  }
  const folders = [...folderSet].map((p) => ({
    path: p, parent: parentOf(p), name: nameOf(p),
    isDir: true, type: "folder", modified: 0
  }));
  const cleanedFiles = directFiles.filter((f) => f.name !== ".keep");

  // At root, inject the virtual /Cloud folder so it's visible.
  if (dir === "/") {
    folders.push({ path: CLOUD_ROOT, parent: "/", name: "Cloud", isDir: true, type: "folder", modified: 0, cloud: true });
  }

  return [
    ...folders.sort((a, b) => a.name.localeCompare(b.name)),
    ...cleanedFiles.sort((a, b) => a.name.localeCompare(b.name))
  ];
}

export async function mkdir(path) {
  path = normalize(path);
  if (isSharedPath(path)) throw new Error("Can't create folders in Shared.");
  if (isCloudPath(path)) {
    const ownPath = cloudOwnDirFromUiPath(path);
    await cloudMkdir(currentUid, ownPath);
    return;
  }
  await writeLocal(path + "/.keep", "");
  notify({ type: "mkdir", path });
}

// Upload a host File object into the given parent dir. Routes to cloud if needed.
export async function uploadFile(parentDir, file) {
  parentDir = normalize(parentDir);
  if (isSharedPath(parentDir)) throw new Error("Can't upload into Shared.");
  if (isCloudPath(parentDir)) {
    const ownDir = cloudOwnDirFromUiPath(parentDir);
    return cloudUploadAt(currentUid, ownDir, file);
  }
  // Local: store as data URL.
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const target = (parentDir.replace(/\/$/, "") + "/" + file.name);
  return writeLocal(target, dataUrl, { type: guessType(file.name) });
}

export async function shareFile(uiPath, recipientUsername) {
  const path = normalize(uiPath);
  if (!isCloudPath(path) || isSharedPath(path)) throw new Error("You can only share files in /Cloud/My Files.");
  const file = findCloudFile(path);
  if (!file) throw new Error("File not found.");
  await cloudShareFile(currentUid, getCurrentUsername(), file.id, recipientUsername);
}

export async function unshareFile(uiPath, recipientUid) {
  const path = normalize(uiPath);
  const file = findCloudFile(path);
  if (!file) throw new Error("File not found.");
  await cloudUnshareFile(currentUid, file.id, recipientUid);
}

export function cloudSharedWith(uiPath) {
  const file = findCloudFile(uiPath);
  if (!file?.sharedWith) return [];
  return Object.keys(file.sharedWith);
}

// We need a username for share writes. Set by main.js on login.
let currentUsername = "user";
export function setCurrentUsername(u) { currentUsername = u; }
function getCurrentUsername() { return currentUsername; }

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
export function guessType(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  return {
    html: "html", htm: "html",
    css: "css",
    js: "js", mjs: "js",
    json: "json",
    md: "markdown", txt: "text",
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image",
    mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio",
    mp4: "video", webm: "video", mov: "video",
    pdf: "pdf",
    zip: "zip",
    blz: "game", game: "game"
  }[ext] || "text";
}

function guessTypeFromMime(mime, name = "") {
  if (mime?.startsWith("image/")) return "image";
  if (mime?.startsWith("video/")) return "video";
  if (mime?.startsWith("audio/")) return "audio";
  if (mime?.includes("pdf")) return "pdf";
  if (mime?.includes("zip")) return "zip";
  return guessType(name);
}

export function fileIcon(item) {
  if (item.cloud && item.path === CLOUD_ROOT) return "☁";
  if (item.isDir) return "📁";
  switch (item.type) {
    case "html": return "🌐";
    case "css":  return "🎨";
    case "js":   return "🟨";
    case "json": return "🧾";
    case "markdown":
    case "text": return "📄";
    case "image": return "🖼";
    case "audio": return "🎵";
    case "video": return "🎬";
    case "pdf":   return "📕";
    case "zip":   return "🗜";
    case "game":  return "🎮";
    default:      return "📄";
  }
}
