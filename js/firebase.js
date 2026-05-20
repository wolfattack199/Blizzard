// Firebase wrapper — auth + Realtime Database via CDN ESM imports.
import { firebaseConfig } from "./config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getDatabase,
  ref,
  set,
  get,
  update,
  remove,
  push,
  child,
  onValue,
  onChildAdded,
  onDisconnect,
  off,
  query,
  orderByChild,
  limitToLast,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getDatabase(app);

// Make sure session survives reload.
setPersistence(auth, browserLocalPersistence).catch(() => {});

// Re-export so app code can stay in one import.
export {
  ref, set, get, update, remove, push, child,
  onValue, onChildAdded, onDisconnect, off, query, orderByChild, limitToLast, serverTimestamp,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged
};

// --------------------------------------------------------------------------
// Username <-> uid mapping. Firebase auth uses email; we synthesize an email
// from the username so users only see usernames.
// --------------------------------------------------------------------------
const DOMAIN_SUFFIX = "@blizzard.os";

export function usernameToEmail(username) {
  return `${username.toLowerCase()}${DOMAIN_SUFFIX}`;
}

export async function isUsernameTaken(username) {
  const snap = await get(ref(db, `usernames/${username.toLowerCase()}`));
  return snap.exists();
}

export async function registerUsername(username, uid) {
  await set(ref(db, `usernames/${username.toLowerCase()}`), uid);
  await set(ref(db, `users/${uid}`), {
    username,
    usernameLower: username.toLowerCase(),
    createdAt: serverTimestamp(),
    profile: { bio: "" }
  });
}

export async function lookupUidByUsername(username) {
  const snap = await get(ref(db, `usernames/${username.toLowerCase()}`));
  return snap.val();
}

export async function loadUser(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.val();
}

export async function listUsers(limit = 100) {
  const snap = await get(ref(db, `users`));
  const out = [];
  snap.forEach((c) => {
    out.push({ uid: c.key, ...c.val() });
  });
  return out.slice(0, limit);
}

// --------------------------------------------------------------------------
// Sites — { domain, owner, files, collaborators, description }
// --------------------------------------------------------------------------
export async function getSite(domain) {
  const snap = await get(ref(db, `sites/${domain.toLowerCase()}`));
  return snap.val();
}

export async function publishSite(domain, owner, files, description = "") {
  const d = domain.toLowerCase();
  const existing = await getSite(d);
  if (existing && existing.owner !== owner && !(existing.collaborators && existing.collaborators[owner])) {
    throw new Error(`Domain "${d}" is owned by another user.`);
  }
  await set(ref(db, `sites/${d}`), {
    domain: d,
    owner: existing?.owner || owner,
    files,
    description: description || existing?.description || "",
    collaborators: existing?.collaborators || {},
    updatedAt: serverTimestamp(),
    createdAt: existing?.createdAt || serverTimestamp()
  });
}

export async function listSites() {
  const snap = await get(ref(db, `sites`));
  const out = [];
  snap.forEach((c) => out.push(c.val()));
  return out;
}

export async function searchSites(termRaw) {
  const term = (termRaw || "").toLowerCase().trim();
  const all = await listSites();
  if (!term) return all;
  return all.filter((s) =>
    (s.domain || "").includes(term) ||
    (s.description || "").toLowerCase().includes(term)
  );
}

export async function addCollaborator(domain, uid) {
  await update(ref(db, `sites/${domain.toLowerCase()}/collaborators`), { [uid]: true });
}

export async function removeCollaborator(domain, uid) {
  await remove(ref(db, `sites/${domain.toLowerCase()}/collaborators/${uid}`));
}

// --------------------------------------------------------------------------
// Messenger — channels (global) + direct messages
// --------------------------------------------------------------------------
export async function ensureDefaultChannels() {
  const snap = await get(ref(db, `channels`));
  if (!snap.exists()) {
    await set(ref(db, `channels`), {
      general: { name: "general", description: "Welcome to Blizzard.", createdAt: serverTimestamp() },
      random:  { name: "random",  description: "Off-topic.",         createdAt: serverTimestamp() },
      dev:     { name: "dev",     description: "Building on Blizzard.", createdAt: serverTimestamp() }
    });
  }
}

export async function listChannels() {
  const snap = await get(ref(db, `channels`));
  const out = [];
  snap.forEach((c) => out.push({ id: c.key, ...c.val() }));
  return out;
}

export function subscribeChannel(channelId, callback) {
  const q = query(ref(db, `messages/channels/${channelId}`), orderByChild("ts"), limitToLast(200));
  const handler = onChildAdded(q, (snap) => callback({ id: snap.key, ...snap.val() }));
  return () => off(q, "child_added", handler);
}

export async function sendChannelMessage(channelId, uid, username, text) {
  await push(ref(db, `messages/channels/${channelId}`), {
    uid, username, text, ts: Date.now()
  });
}

export function dmPairKey(a, b) {
  return [a, b].sort().join("__");
}

export function subscribeDM(uidA, uidB, callback) {
  const key = dmPairKey(uidA, uidB);
  const q = query(ref(db, `messages/dms/${key}`), orderByChild("ts"), limitToLast(200));
  const handler = onChildAdded(q, (snap) => callback({ id: snap.key, ...snap.val() }));
  return () => off(q, "child_added", handler);
}

export async function sendDM(uidA, uidB, fromUid, fromUsername, text) {
  const key = dmPairKey(uidA, uidB);
  await push(ref(db, `messages/dms/${key}`), {
    uid: fromUid, username: fromUsername, text, ts: Date.now()
  });
}

// --------------------------------------------------------------------------
// Games — published web games (HTML in DB)
// --------------------------------------------------------------------------
export async function listGames() {
  const snap = await get(ref(db, `games`));
  const out = [];
  snap.forEach((c) => out.push({ id: c.key, ...c.val() }));
  return out;
}

export async function publishGame(authorUid, authorUsername, { title, description, code, thumb }) {
  const id = push(ref(db, `games`)).key;
  await set(ref(db, `games/${id}`), {
    id, title, description, code,
    thumb: thumb || "🎮",
    authorUid, authorUsername,
    createdAt: serverTimestamp()
  });
  return id;
}

export async function getGame(id) {
  const snap = await get(ref(db, `games/${id}`));
  return snap.val();
}

// --------------------------------------------------------------------------
// Notes — synced sticky notes per user
// --------------------------------------------------------------------------
export function subscribeNotes(uid, callback) {
  const r = ref(db, `notes/${uid}`);
  const handler = onValue(r, (snap) => {
    const out = [];
    snap.forEach((c) => out.push({ id: c.key, ...c.val() }));
    callback(out);
  });
  return () => off(r, "value", handler);
}

export async function upsertNote(uid, note) {
  const id = note.id || push(ref(db, `notes/${uid}`)).key;
  await set(ref(db, `notes/${uid}/${id}`), { ...note, id, updated: Date.now() });
  return id;
}

export async function deleteNote(uid, id) {
  await remove(ref(db, `notes/${uid}/${id}`));
}

// --------------------------------------------------------------------------
// Profile editing
// --------------------------------------------------------------------------
export async function updateProfile(uid, profile) {
  await update(ref(db, `users/${uid}/profile`), profile);
}

// --------------------------------------------------------------------------
// Blizzard Tube — video entries + comments
// --------------------------------------------------------------------------
export const TUBE_MAX_BYTES = 6 * 1024 * 1024; // 6 MB max video

export async function listTubes() {
  const snap = await get(ref(db, `tubes`));
  const out = [];
  snap.forEach((c) => out.push({ id: c.key, ...c.val() }));
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// Upload a video file. `meta` may include { title, description, tags: [], thumb }.
// `tags` is an array of lowercase strings.
export async function publishTubeFile(authorUid, authorUsername, file, meta = {}) {
  if (file.size > TUBE_MAX_BYTES) {
    throw new Error(`Video too large (${(file.size/1024/1024).toFixed(1)} MB). Limit is ${TUBE_MAX_BYTES/1024/1024} MB.`);
  }
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const id = push(ref(db, `tubes`)).key;
  await set(ref(db, `tubes/${id}`), {
    id,
    title: meta.title || file.name,
    description: meta.description || "",
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    thumb: meta.thumb || "",
    mime: file.type || "video/mp4",
    size: file.size,
    kind: "upload",
    authorUid, authorUsername,
    views: 0,
    createdAt: Date.now()
  });
  await set(ref(db, `tube-blobs/${id}`), dataUrl);
  return id;
}

// Legacy URL-based publish (kept for any older entries / external embed flow).
export async function publishTube(authorUid, authorUsername, { title, description, url, kind, tags }) {
  const id = push(ref(db, `tubes`)).key;
  await set(ref(db, `tubes/${id}`), {
    id, title, description, url, kind: kind || "url",
    tags: Array.isArray(tags) ? tags : [],
    authorUid, authorUsername,
    views: 0, createdAt: Date.now()
  });
  return id;
}

export async function getTube(id) {
  const snap = await get(ref(db, `tubes/${id}`));
  return snap.val();
}
export async function getTubeBlob(id) {
  return (await get(ref(db, `tube-blobs/${id}`))).val();
}
export async function deleteTube(id) {
  await remove(ref(db, `tubes/${id}`));
  await remove(ref(db, `tube-blobs/${id}`));
}

export async function incrementTubeView(id) {
  const r = ref(db, `tubes/${id}/views`);
  const cur = (await get(r)).val() || 0;
  await set(r, cur + 1);
}

export function subscribeTubeComments(tubeId, callback) {
  const q = query(ref(db, `tubeComments/${tubeId}`), orderByChild("ts"), limitToLast(200));
  const handler = onChildAdded(q, (snap) => callback({ id: snap.key, ...snap.val() }));
  return () => off(q, "child_added", handler);
}

export async function addTubeComment(tubeId, uid, username, text) {
  await push(ref(db, `tubeComments/${tubeId}`), { uid, username, text, ts: Date.now() });
}

// --------------------------------------------------------------------------
// Messenger — user-created servers
// --------------------------------------------------------------------------
export async function createServer(ownerUid, name) {
  const id = push(ref(db, `servers`)).key;
  await set(ref(db, `servers/${id}`), {
    id, name, ownerUid,
    members: { [ownerUid]: true },
    channels: {
      general: { name: "general" }
    },
    createdAt: Date.now()
  });
  return id;
}

export async function listMyServers(uid) {
  const snap = await get(ref(db, `servers`));
  const out = [];
  snap.forEach((c) => {
    const v = c.val();
    if (v.members && v.members[uid]) out.push({ id: c.key, ...v });
  });
  return out;
}

export async function getServer(id) {
  const snap = await get(ref(db, `servers/${id}`));
  return snap.val();
}

export async function inviteToServer(serverId, uid) {
  await update(ref(db, `servers/${serverId}/members`), { [uid]: true });
}

export async function addChannelToServer(serverId, channelName) {
  const safe = channelName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  await update(ref(db, `servers/${serverId}/channels`), { [safe]: { name: safe } });
  return safe;
}

export function subscribeServerChannel(serverId, channelId, callback) {
  const q = query(ref(db, `serverMessages/${serverId}/${channelId}`), orderByChild("ts"), limitToLast(200));
  const handler = onChildAdded(q, (snap) => callback({ id: snap.key, ...snap.val() }));
  return () => off(q, "child_added", handler);
}

export async function sendServerMessage(serverId, channelId, uid, username, text) {
  await push(ref(db, `serverMessages/${serverId}/${channelId}`), {
    uid, username, text, ts: Date.now()
  });
}

// --------------------------------------------------------------------------
// Cloud files — per-user files synced across devices, with folders + sharing.
//
// Data model:
//   cloud-files/{ownerUid}/{fid}: {
//     id, path: "/Cloud/Photos/cat.jpg", parent, name, size, type,
//     uploadedAt, ownerUid, sharedWith: { recipientUid: true }
//   }
//   cloud-blobs/{ownerUid}/{fid}: dataUrl
//   cloud-shares/{recipientUid}/{shareKey}: {
//     ownerUid, ownerUsername, fid, name, size, type, sharedAt
//   }
//   cloud-folders/{ownerUid}/{folderKey}: { path }   (so empty folders persist)
// --------------------------------------------------------------------------
export const CLOUD_MAX_BYTES = 4 * 1024 * 1024; // 4 MB per file

export function subscribeCloudFiles(uid, callback) {
  const r = ref(db, `cloud-files/${uid}`);
  const handler = onValue(r, (snap) => {
    const out = [];
    snap.forEach((c) => out.push(c.val()));
    callback(out);
  });
  return () => off(r, "value", handler);
}

export function subscribeCloudFolders(uid, callback) {
  const r = ref(db, `cloud-folders/${uid}`);
  const handler = onValue(r, (snap) => {
    const out = [];
    snap.forEach((c) => out.push(c.val().path));
    callback(out);
  });
  return () => off(r, "value", handler);
}

export function subscribeCloudShares(uid, callback) {
  const r = ref(db, `cloud-shares/${uid}`);
  const handler = onValue(r, (snap) => {
    const out = [];
    snap.forEach((c) => out.push(c.val()));
    callback(out);
  });
  return () => off(r, "value", handler);
}

export async function cloudUploadAt(uid, parentPath, file) {
  if (file.size > CLOUD_MAX_BYTES) {
    throw new Error(`File too large (${(file.size/1024/1024).toFixed(1)} MB). Limit is ${CLOUD_MAX_BYTES/1024/1024} MB.`);
  }
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const id = push(ref(db, `cloud-files/${uid}`)).key;
  const path = (parentPath.replace(/\/$/, "") + "/" + file.name);
  await set(ref(db, `cloud-files/${uid}/${id}`), {
    id, path,
    parent: parentPath.replace(/\/$/, ""),
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream",
    uploadedAt: Date.now(),
    ownerUid: uid,
    sharedWith: {}
  });
  await set(ref(db, `cloud-blobs/${uid}/${id}`), dataUrl);
  return id;
}

export async function cloudWriteText(uid, path, content) {
  // Used for "New file" on cloud paths (text content).
  const bytes = new Blob([content]).size;
  if (bytes > CLOUD_MAX_BYTES) throw new Error(`File too large.`);
  const id = push(ref(db, `cloud-files/${uid}`)).key;
  const parts = path.split("/");
  const name = parts.pop();
  const parent = parts.join("/") || "/";
  const dataUrl = "data:text/plain;base64," + btoa(unescape(encodeURIComponent(content || "")));
  await set(ref(db, `cloud-files/${uid}/${id}`), {
    id, path, parent, name,
    size: bytes,
    type: "text/plain",
    uploadedAt: Date.now(),
    ownerUid: uid,
    sharedWith: {}
  });
  await set(ref(db, `cloud-blobs/${uid}/${id}`), dataUrl);
  return id;
}

export async function cloudMkdir(uid, path) {
  const id = push(ref(db, `cloud-folders/${uid}`)).key;
  await set(ref(db, `cloud-folders/${uid}/${id}`), { path });
}

export async function cloudGetBlob(ownerUid, fid) {
  const snap = await get(ref(db, `cloud-blobs/${ownerUid}/${fid}`));
  return snap.val();
}

export async function cloudGetFile(ownerUid, fid) {
  const snap = await get(ref(db, `cloud-files/${ownerUid}/${fid}`));
  return snap.val();
}

export async function cloudDeleteFile(ownerUid, fid) {
  // Clean up share index entries first.
  const fSnap = await get(ref(db, `cloud-files/${ownerUid}/${fid}`));
  const f = fSnap.val();
  if (f?.sharedWith) {
    for (const rcpt of Object.keys(f.sharedWith)) {
      await remove(ref(db, `cloud-shares/${rcpt}/${ownerUid}__${fid}`));
    }
  }
  await remove(ref(db, `cloud-files/${ownerUid}/${fid}`));
  await remove(ref(db, `cloud-blobs/${ownerUid}/${fid}`));
}

export async function cloudDeleteFolder(uid, folderPath) {
  // Remove the folder marker and every file underneath it.
  const folders = await get(ref(db, `cloud-folders/${uid}`));
  const matches = [];
  folders.forEach((c) => {
    const v = c.val();
    if (v.path === folderPath || v.path.startsWith(folderPath + "/")) matches.push(c.key);
  });
  for (const k of matches) await remove(ref(db, `cloud-folders/${uid}/${k}`));

  const files = await get(ref(db, `cloud-files/${uid}`));
  const fids = [];
  files.forEach((c) => {
    const v = c.val();
    if (v.parent === folderPath || (v.parent || "").startsWith(folderPath + "/")) fids.push(c.key);
  });
  for (const fid of fids) await cloudDeleteFile(uid, fid);
}

export async function cloudRenameFile(uid, fid, newName) {
  const snap = await get(ref(db, `cloud-files/${uid}/${fid}`));
  const f = snap.val();
  if (!f) return;
  const newPath = (f.parent === "/" ? "" : f.parent) + "/" + newName;
  await update(ref(db, `cloud-files/${uid}/${fid}`), { name: newName, path: newPath });

  // Refresh share index entries if any (they snapshot name).
  if (f.sharedWith) {
    for (const rcpt of Object.keys(f.sharedWith)) {
      await update(ref(db, `cloud-shares/${rcpt}/${uid}__${fid}`), { name: newName });
    }
  }
}

// Rename a cloud folder: rewrite path on all files/folders under it.
export async function cloudRenameFolder(uid, oldOwnPath, newOwnPath) {
  if (!oldOwnPath || oldOwnPath === "/") throw new Error("Can't rename root.");

  const files = await get(ref(db, `cloud-files/${uid}`));
  const updatesFile = {};
  files.forEach((c) => {
    const v = c.val();
    if (!v?.path) return;
    if (v.path === oldOwnPath || v.path.startsWith(oldOwnPath + "/")) {
      const np = newOwnPath + v.path.slice(oldOwnPath.length);
      const parts = np.split("/");
      const name = parts.pop();
      const parent = parts.join("/") || "/";
      updatesFile[`cloud-files/${uid}/${c.key}/path`] = np;
      updatesFile[`cloud-files/${uid}/${c.key}/parent`] = parent;
      updatesFile[`cloud-files/${uid}/${c.key}/name`] = name;
    }
  });

  const folders = await get(ref(db, `cloud-folders/${uid}`));
  folders.forEach((c) => {
    const v = c.val();
    if (!v?.path) return;
    if (v.path === oldOwnPath || v.path.startsWith(oldOwnPath + "/")) {
      const np = newOwnPath + v.path.slice(oldOwnPath.length);
      updatesFile[`cloud-folders/${uid}/${c.key}/path`] = np;
    }
  });

  if (Object.keys(updatesFile).length > 0) {
    await update(ref(db), updatesFile);
  }
}

export async function cloudShareFile(ownerUid, ownerUsername, fid, recipientUsername) {
  const recipientUid = await lookupUidByUsername(recipientUsername);
  if (!recipientUid) throw new Error("No such user.");
  if (recipientUid === ownerUid) throw new Error("You can't share with yourself.");
  const fileSnap = await get(ref(db, `cloud-files/${ownerUid}/${fid}`));
  const file = fileSnap.val();
  if (!file) throw new Error("File not found.");
  await update(ref(db, `cloud-files/${ownerUid}/${fid}/sharedWith`), { [recipientUid]: true });
  await set(ref(db, `cloud-shares/${recipientUid}/${ownerUid}__${fid}`), {
    ownerUid, ownerUsername,
    fid,
    name: file.name,
    size: file.size,
    type: file.type,
    sharedAt: Date.now()
  });
  return recipientUid;
}

export async function cloudUnshareFile(ownerUid, fid, recipientUid) {
  await remove(ref(db, `cloud-files/${ownerUid}/${fid}/sharedWith/${recipientUid}`));
  await remove(ref(db, `cloud-shares/${recipientUid}/${ownerUid}__${fid}`));
}

// --------------------------------------------------------------------------
// Installed apps — per-user list, drives what's in the start menu.
// --------------------------------------------------------------------------
export async function listInstalledApps(uid) {
  const snap = await get(ref(db, `installed/${uid}`));
  const out = [];
  snap.forEach((c) => out.push(c.val()));
  return out;
}
export function subscribeInstalledApps(uid, cb) {
  const r = ref(db, `installed/${uid}`);
  const handler = onValue(r, (snap) => {
    const out = [];
    snap.forEach((c) => out.push(c.val()));
    cb(out);
  });
  return () => off(r, "value", handler);
}
export async function installApp(uid, app) {
  // app = { id, name, glyph, description, builtin?, code?, source }
  await set(ref(db, `installed/${uid}/${app.id}`), { ...app, installedAt: Date.now() });
}
export async function uninstallApp(uid, id) {
  await remove(ref(db, `installed/${uid}/${id}`));
}

// --------------------------------------------------------------------------
// Desktop layout — per-user icon positions, synced across devices.
// --------------------------------------------------------------------------
export async function loadDesktopIconPositions(uid) {
  const snap = await get(ref(db, `desktop-layouts/${uid}/icons`));
  return normalizeIconPositions(snap.val());
}

export function subscribeDesktopIconPositions(uid, callback) {
  const r = ref(db, `desktop-layouts/${uid}/icons`);
  return onValue(r, (snap) => {
    callback(normalizeIconPositions(snap.val()));
  }, () => callback({}));
}

export async function saveDesktopIconPositions(uid, positions) {
  await set(ref(db, `desktop-layouts/${uid}/icons`), serializeIconPositions(positions));
}

function serializeIconPositions(positions = {}) {
  const out = {};
  for (const [id, pos] of Object.entries(positions || {})) {
    const safeId = encodeKey(id);
    const x = Number.isFinite(pos?.x) ? Math.round(pos.x) : 0;
    const y = Number.isFinite(pos?.y) ? Math.round(pos.y) : 0;
    out[safeId] = { id, x, y, updatedAt: Date.now() };
  }
  return out;
}

function normalizeIconPositions(raw = {}) {
  const out = {};
  for (const [key, pos] of Object.entries(raw || {})) {
    const id = pos?.id || key;
    if (!id) continue;
    const x = Number(pos?.x);
    const y = Number(pos?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out[id] = { x, y };
  }
  return out;
}

// Apps available in the Blizzard Store. Official app records are seeded into
// Firebase so the Store catalog is shared across users/devices instead of
// being hardcoded in the Store UI.
const DEFAULT_STORE_APPS = [
  {
    id: "engine",
    title: "Blizzard Engine",
    glyph: "BE",
    builtin: "engine",
    official: true,
    description: "Drag-and-drop 2D game maker. Drop sprites onto a stage, choose the player, hit Run, and publish to the Community Hub.",
    authorUid: "system",
    authorUsername: "Blizzard",
    createdAt: 0
  },
  {
    id: "paint",
    title: "Paint",
    glyph: "P",
    builtin: "paint",
    official: true,
    description: "Classic canvas drawing with pencil, brush, eraser, fill, line, rectangle, and save-to-files.",
    authorUid: "system",
    authorUsername: "Blizzard",
    createdAt: 0
  },
  {
    id: "notes",
    title: "Notes",
    glyph: "N",
    builtin: "notes",
    official: true,
    description: "Sticky notes that sync to your Blizzard account.",
    authorUid: "system",
    authorUsername: "Blizzard",
    createdAt: 0
  },
  {
    id: "calculator",
    title: "Calculator",
    glyph: "C",
    builtin: "calculator",
    official: true,
    description: "Standard four-function calculator with keyboard shortcuts.",
    authorUid: "system",
    authorUsername: "Blizzard",
    createdAt: 0
  },
  {
    id: "music",
    title: "Music",
    glyph: "M",
    builtin: "music",
    official: true,
    description: "Drag-and-drop audio player for local .mp3 and .wav files.",
    authorUid: "system",
    authorUsername: "Blizzard",
    createdAt: 0
  }
];

export async function ensureDefaultStoreApps() {
  await Promise.all(DEFAULT_STORE_APPS.map(async (app) => {
    const snap = await get(ref(db, `apps/${app.id}`));
    if (!snap.exists()) await set(ref(db, `apps/${app.id}`), app);
  }));
}

export async function listStoreApps() {
  const snap = await get(ref(db, `apps`));
  const out = [];
  snap.forEach((c) => out.push({ id: c.key, ...c.val() }));
  return out.sort((a, b) => {
    const official = Number(!!b.official) - Number(!!a.official);
    if (official) return official;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}
export async function publishStoreApp(authorUid, authorUsername, { title, description, code, glyph }) {
  const id = push(ref(db, `apps`)).key;
  await set(ref(db, `apps/${id}`), {
    id, title, description, code, glyph: glyph || "📦",
    authorUid, authorUsername, createdAt: Date.now()
  });
  return id;
}
export async function getStoreApp(id) {
  return (await get(ref(db, `apps/${id}`))).val();
}

// --------------------------------------------------------------------------
// Livestreams — WebRTC peer signaling lives in Firebase RTDB.
// --------------------------------------------------------------------------
export async function createStream(ownerUid, ownerUsername, title) {
  // Enforce one live stream per user: end any prior live streams they own.
  await killAllMyLiveStreams(ownerUid);
  const id = push(ref(db, `streams`)).key;
  await set(ref(db, `streams/${id}`), {
    id, ownerUid, ownerUsername, title,
    startedAt: Date.now(), live: true, viewers: 0
  });
  return id;
}
export async function endStream(streamId) {
  await update(ref(db, `streams/${streamId}`), { live: false, endedAt: Date.now() });
}
// Register an auto-cleanup so this stream is marked offline if the streamer
// disconnects without clicking Stop (closed tab, lost connection, etc.).
export function registerStreamOnDisconnect(streamId) {
  const r = ref(db, `streams/${streamId}`);
  // Cancel any prior onDisconnect on this ref, then register fresh.
  onDisconnect(r).cancel().catch(() => {});
  onDisconnect(r).update({ live: false, endedAt: Date.now() }).catch(() => {});
}
// Mark every still-live stream owned by this user as ended.
// Useful when the Livestream app mounts and the user wants a clean slate.
export async function killAllMyLiveStreams(uid) {
  const snap = await get(ref(db, `streams`));
  const ops = [];
  snap.forEach((c) => {
    const v = c.val();
    if (v && v.live && v.ownerUid === uid) {
      ops.push(update(ref(db, `streams/${c.key}`), { live: false, endedAt: Date.now() }));
    }
  });
  await Promise.all(ops);
}
export async function listLiveStreams() {
  const snap = await get(ref(db, `streams`));
  const out = [];
  snap.forEach((c) => {
    const v = c.val();
    if (v.live) out.push(v);
  });
  return out;
}
export function subscribeLiveStreams(cb) {
  const r = ref(db, `streams`);
  const handler = onValue(r, (snap) => {
    const out = [];
    snap.forEach((c) => {
      const v = c.val();
      if (v.live) out.push(v);
    });
    cb(out);
  });
  return () => off(r, "value", handler);
}
export async function getStream(id) {
  return (await get(ref(db, `streams/${id}`))).val();
}
// Real-time chat for a stream.
export function subscribeStreamChat(streamId, cb) {
  const q = query(ref(db, `stream-chat/${streamId}`), orderByChild("ts"), limitToLast(200));
  const handler = onChildAdded(q, (snap) => cb({ id: snap.key, ...snap.val() }));
  return () => off(q, "child_added", handler);
}
export async function sendStreamChat(streamId, uid, username, text) {
  await push(ref(db, `stream-chat/${streamId}`), { uid, username, text, ts: Date.now() });
}
export async function setStreamViewers(streamId, n) {
  await update(ref(db, `streams/${streamId}`), { viewers: n });
}
export async function setStreamThumbnail(streamId, dataUrl) {
  await update(ref(db, `streams/${streamId}`), { thumb: dataUrl });
}
// Signaling subnodes used by the WebRTC dance:
//   streams/{id}/offers/{viewerUid}/{offerOrAnswer}
//   streams/{id}/ice/host/{viewerUid}/{candidateKey}
//   streams/{id}/ice/viewer/{viewerUid}/{candidateKey}
export function streamRef(path) { return ref(db, `streams/${path}`); }
export function rtdbSet(path, value) { return set(ref(db, path), value); }
export function rtdbPush(path, value) { return push(ref(db, path), value); }
export function rtdbOn(path, type, cb) {
  const r = ref(db, path);
  if (type === "child_added") {
    const handler = onChildAdded(r, (snap) => cb({ key: snap.key, val: snap.val() }));
    return () => off(r, "child_added", handler);
  }
  const handler = onValue(r, (snap) => cb(snap.val()));
  return () => off(r, "value", handler);
}

// --------------------------------------------------------------------------
// Tunes — Spotify-like. Tracks are uploaded by users; everyone can browse.
// Audio blobs are split out (cloud-tune-blobs) so listing stays fast.
// --------------------------------------------------------------------------
export const TUNE_MAX_BYTES = 4 * 1024 * 1024; // 4 MB audio per track

export async function publishTune(ownerUid, ownerUsername, file, meta) {
  if (file.size > TUNE_MAX_BYTES) {
    throw new Error(`Track too large (${(file.size/1024/1024).toFixed(1)} MB). Limit is ${TUNE_MAX_BYTES/1024/1024} MB.`);
  }
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
  const id = push(ref(db, `tunes`)).key;
  await set(ref(db, `tunes/${id}`), {
    id,
    ownerUid, ownerUsername,
    title: meta.title || file.name,
    artist: meta.artist || ownerUsername,
    kind: meta.kind || "music",   // "music" | "podcast"
    cover: meta.cover || "",
    size: file.size,
    mime: file.type || "audio/mpeg",
    plays: 0,
    likes: 0,
    createdAt: Date.now()
  });
  await set(ref(db, `tune-blobs/${id}`), dataUrl);
  return id;
}
export async function listTunes() {
  const snap = await get(ref(db, `tunes`));
  const out = [];
  snap.forEach((c) => out.push(c.val()));
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
export function subscribeTunes(cb) {
  const r = ref(db, `tunes`);
  const handler = onValue(r, (snap) => {
    const out = [];
    snap.forEach((c) => out.push(c.val()));
    out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    cb(out);
  });
  return () => off(r, "value", handler);
}
export async function getTuneBlob(id) {
  return (await get(ref(db, `tune-blobs/${id}`))).val();
}
export async function deleteTune(id) {
  await remove(ref(db, `tunes/${id}`));
  await remove(ref(db, `tune-blobs/${id}`));
}
export async function incrementTunePlays(id) {
  const r = ref(db, `tunes/${id}/plays`);
  const cur = (await get(r)).val() || 0;
  await set(r, cur + 1);
}

// User playlists — { id, ownerUid, name, kind, trackIds: [] }
export async function listPlaylists(uid) {
  const snap = await get(ref(db, `playlists/${uid}`));
  const out = [];
  snap.forEach((c) => out.push(c.val()));
  return out;
}
export async function createPlaylist(uid, name) {
  const id = push(ref(db, `playlists/${uid}`)).key;
  await set(ref(db, `playlists/${uid}/${id}`), {
    id, ownerUid: uid, name, trackIds: [], createdAt: Date.now()
  });
  return id;
}
export async function updatePlaylist(uid, id, patch) {
  await update(ref(db, `playlists/${uid}/${id}`), patch);
}
export async function deletePlaylist(uid, id) {
  await remove(ref(db, `playlists/${uid}/${id}`));
}

// --------------------------------------------------------------------------
// Inbox — email-style threads (with subject lines), Discord-style real-time
// messages inside each thread.
//
// Data model:
//   mail/threads/{tid}: { id, subject, createdAt, lastTs, lastFrom, lastSnippet,
//                         participants: { uid: username } }
//   mail/messages/{tid}/{mid}: { fromUid, fromUsername, text, ts }
//   mail/indexes/{uid}/{tid}: { tid, otherUid, otherUsername, subject,
//                               lastTs, lastFrom, lastSnippet, unread }
// --------------------------------------------------------------------------
export async function createMailThread(authorUid, authorUsername, otherUid, otherUsername, subject, firstMessage) {
  const id = push(ref(db, `mail/threads`)).key;
  const now = Date.now();
  const snippet = (firstMessage || "").slice(0, 100);
  const thread = {
    id, subject, createdAt: now,
    lastTs: now, lastFrom: authorUsername, lastSnippet: snippet,
    participants: { [authorUid]: authorUsername, [otherUid]: otherUsername }
  };
  await set(ref(db, `mail/threads/${id}`), thread);
  if (firstMessage) {
    const mid = push(ref(db, `mail/messages/${id}`)).key;
    await set(ref(db, `mail/messages/${id}/${mid}`), {
      fromUid: authorUid, fromUsername: authorUsername, text: firstMessage, ts: now
    });
  }
  // Inverted index entries
  await set(ref(db, `mail/indexes/${authorUid}/${id}`), {
    tid: id, otherUid, otherUsername, subject,
    lastTs: now, lastFrom: authorUsername, lastSnippet: snippet, unread: false
  });
  await set(ref(db, `mail/indexes/${otherUid}/${id}`), {
    tid: id, otherUid: authorUid, otherUsername: authorUsername, subject,
    lastTs: now, lastFrom: authorUsername, lastSnippet: snippet, unread: true
  });
  return id;
}
export function subscribeMyMailThreads(uid, cb) {
  const r = ref(db, `mail/indexes/${uid}`);
  const handler = onValue(r, (snap) => {
    const out = [];
    snap.forEach((c) => out.push(c.val()));
    out.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    cb(out);
  });
  return () => off(r, "value", handler);
}
export async function getMailThread(tid) {
  return (await get(ref(db, `mail/threads/${tid}`))).val();
}
export function subscribeMailMessages(tid, cb) {
  const q = query(ref(db, `mail/messages/${tid}`), orderByChild("ts"), limitToLast(500));
  const handler = onChildAdded(q, (snap) => cb({ id: snap.key, ...snap.val() }));
  return () => off(q, "child_added", handler);
}
export async function sendMailMessage(tid, fromUid, fromUsername, text) {
  const now = Date.now();
  const snippet = (text || "").slice(0, 100);
  const mid = push(ref(db, `mail/messages/${tid}`)).key;
  await set(ref(db, `mail/messages/${tid}/${mid}`), {
    fromUid, fromUsername, text, ts: now
  });
  // Update thread metadata + per-recipient indexes
  await update(ref(db, `mail/threads/${tid}`), { lastTs: now, lastFrom: fromUsername, lastSnippet: snippet });
  const thread = await getMailThread(tid);
  if (thread?.participants) {
    for (const [uid, _] of Object.entries(thread.participants)) {
      await update(ref(db, `mail/indexes/${uid}/${tid}`), {
        lastTs: now, lastFrom: fromUsername, lastSnippet: snippet,
        unread: uid !== fromUid
      });
    }
  }
}
export async function markMailRead(uid, tid) {
  await update(ref(db, `mail/indexes/${uid}/${tid}`), { unread: false });
}
export async function deleteMailThread(uid, tid) {
  await remove(ref(db, `mail/indexes/${uid}/${tid}`));
  // Other participants keep their copy; only delete the thread if no one
  // references it anymore (left as a cleanup for later).
}

// --------------------------------------------------------------------------
// Blizz Web Store — browser extensions. Each extension is a JS snippet that
// runs inside the Blizzard browser as a content script when enabled.
// Stored under `extensions/{id}` and per-user installs under `installed-ext/{uid}`.
// --------------------------------------------------------------------------
export async function listExtensions() {
  const snap = await get(ref(db, `extensions`));
  const out = [];
  snap.forEach((c) => out.push({ id: c.key, ...c.val() }));
  return out.sort((a, b) => (b.installs || 0) - (a.installs || 0));
}
export async function publishExtension(authorUid, authorUsername, { name, description, code, glyph }) {
  const id = push(ref(db, `extensions`)).key;
  await set(ref(db, `extensions/${id}`), {
    id, name, description, code,
    glyph: glyph || "🧩",
    authorUid, authorUsername,
    installs: 0,
    createdAt: Date.now()
  });
  return id;
}
export async function getExtension(id) { return (await get(ref(db, `extensions/${id}`))).val(); }
export async function deleteExtension(id) { await remove(ref(db, `extensions/${id}`)); }

export function subscribeMyExtensions(uid, cb) {
  const r = ref(db, `installed-ext/${uid}`);
  const handler = onValue(r, (snap) => {
    const out = [];
    snap.forEach((c) => out.push(c.val()));
    cb(out);
  });
  return () => off(r, "value", handler);
}
export async function installExtension(uid, ext) {
  await set(ref(db, `installed-ext/${uid}/${ext.id}`), {
    id: ext.id, name: ext.name, glyph: ext.glyph, code: ext.code,
    enabled: true, installedAt: Date.now()
  });
  // Bump install counter
  const rc = ref(db, `extensions/${ext.id}/installs`);
  const cur = (await get(rc)).val() || 0;
  await set(rc, cur + 1);
}
export async function uninstallExtension(uid, id) {
  await remove(ref(db, `installed-ext/${uid}/${id}`));
}
export async function setExtensionEnabled(uid, id, enabled) {
  await update(ref(db, `installed-ext/${uid}/${id}`), { enabled });
}

// --------------------------------------------------------------------------
// Per-site live data — used by the `bz` API exposed to site iframes.
// Each site (blizz://<domain>) gets its own scoped key-value store.
// --------------------------------------------------------------------------
export async function siteDataGet(domain, key) {
  const snap = await get(ref(db, `siteData/${domain}/${encodeKey(key)}`));
  return snap.val();
}
export async function siteDataSet(domain, key, value) {
  await set(ref(db, `siteData/${domain}/${encodeKey(key)}`), value);
}
export async function siteDataPush(domain, key, value) {
  const id = push(ref(db, `siteData/${domain}/${encodeKey(key)}`)).key;
  await set(ref(db, `siteData/${domain}/${encodeKey(key)}/${id}`), { ...value, _id: id });
  return id;
}
export async function siteDataList(domain, key) {
  const snap = await get(ref(db, `siteData/${domain}/${encodeKey(key)}`));
  const out = [];
  snap.forEach((c) => out.push(c.val()));
  return out;
}
export function siteDataSubscribe(domain, key, cb) {
  const r = ref(db, `siteData/${domain}/${encodeKey(key)}`);
  const handler = onValue(r, (snap) => cb(snap.val()));
  return () => off(r, "value", handler);
}
function encodeKey(k) { return String(k || "").replace(/[.#$\[\]/]/g, "_"); }

// --------------------------------------------------------------------------
// Site reports — users flag sites they think should be reviewed/taken down.
// --------------------------------------------------------------------------
export async function reportSite(domain, reporterUid, reporterUsername, reason) {
  const id = push(ref(db, `reports`)).key;
  await set(ref(db, `reports/${id}`), {
    id, domain, reporterUid, reporterUsername, reason,
    ts: Date.now(), status: "open"
  });
  return id;
}
export async function listReports() {
  const snap = await get(ref(db, `reports`));
  const out = [];
  snap.forEach((c) => out.push(c.val()));
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
export async function setReportStatus(id, status) {
  await update(ref(db, `reports/${id}`), { status });
}

// --------------------------------------------------------------------------
// Seed default games (run once if /games is empty)
// --------------------------------------------------------------------------
export async function seedGamesIfEmpty() {
  const snap = await get(ref(db, `games`));
  if (snap.exists()) return;
  try {
    const res = await fetch("./data/seed-games.json");
    const games = await res.json();
    for (const g of games) {
      const id = push(ref(db, `games`)).key;
      await set(ref(db, `games/${id}`), {
        id,
        ...g,
        authorUid: "system",
        authorUsername: "Blizzard",
        createdAt: Date.now()
      });
    }
  } catch (e) {
    console.warn("Game seed skipped:", e);
  }
}
