// Firebase wrapper — auth + Realtime Database via CDN ESM imports.
import { firebaseConfig } from "./config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
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
  runTransaction,
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
  onValue, onChildAdded, onDisconnect, off, query, orderByChild, limitToLast, runTransaction, serverTimestamp,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, reauthenticateWithCredential, EmailAuthProvider,
  signOut, onAuthStateChanged
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
    role: "user",
    quota_tier: "free",
    storage_used: 0,
    storage_breakdown: {},
    points: 0,
    counters: {},
    achievements: {},
    profile: { bio: "" }
  });
}

export async function lookupUidByUsername(username) {
  const snap = await get(ref(db, `usernames/${username.toLowerCase()}`));
  return snap.val();
}

export async function reauthenticateBlizzardUser(username, password) {
  const current = auth.currentUser;
  if (!current) throw new Error("Sign in before opening admin tools.");
  const email = usernameToEmail(username);
  if ((current.email || "").toLowerCase() !== email.toLowerCase()) {
    throw new Error("Use the password for the account that is currently signed in.");
  }
  const credential = EmailAuthProvider.credential(email, password);
  await reauthenticateWithCredential(current, credential);
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
// Storage quotas. Blob-heavy content is tracked per user before the write
// happens so uploads fail early and concurrent uploads race safely.
// --------------------------------------------------------------------------
export const QUOTA_FREE_BYTES = 100 * 1024 * 1024;
export const QUOTA_TRUSTED_BYTES = 1024 * 1024 * 1024;

export class QuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export async function getQuota(uid) {
  const user = await loadUser(uid).catch(() => null);
  return user?.quota_tier === "trusted" ? QUOTA_TRUSTED_BYTES : QUOTA_FREE_BYTES;
}

export async function trackUpload(uid, bytes, category = "other") {
  const amount = Math.max(0, Math.ceil(Number(bytes) || 0));
  if (!uid || amount <= 0) return;
  const quotaBytes = await getQuota(uid);
  const result = await runTransaction(ref(db, `users/${uid}/storage_used`), (cur) => {
    const next = (Number(cur) || 0) + amount;
    if (next > quotaBytes) return;
    return next;
  });
  if (!result.committed) {
    const used = (await get(ref(db, `users/${uid}/storage_used`))).val() || 0;
    throw new QuotaExceededError(
      `Upload would exceed your ${formatBytes(quotaBytes)} quota. ` +
      `You have ${formatBytes(Math.max(0, quotaBytes - used))} free.`
    );
  }
  await runTransaction(ref(db, `users/${uid}/storage_breakdown/${encodeKey(category)}`), (cur) => {
    return (Number(cur) || 0) + amount;
  });
}

export async function trackDelete(uid, bytes, category = "other") {
  const amount = Math.max(0, Math.ceil(Number(bytes) || 0));
  if (!uid || amount <= 0) return;
  await Promise.all([
    runTransaction(ref(db, `users/${uid}/storage_used`), (cur) => Math.max(0, (Number(cur) || 0) - amount)),
    runTransaction(ref(db, `users/${uid}/storage_breakdown/${encodeKey(category)}`), (cur) => Math.max(0, (Number(cur) || 0) - amount))
  ]);
}

export async function ensureStorageBackfill(uid) {
  const user = await loadUser(uid).catch(() => null);
  if (!user) return null;
  if (typeof user.storage_used === "number" && user.storage_backfilledAt) {
    return getStorageSummary(uid, { skipBackfill: true });
  }
  const breakdown = await computeStorageBreakdown(uid);
  const used = Object.values(breakdown).reduce((sum, bytes) => sum + (Number(bytes) || 0), 0);
  await update(ref(db, `users/${uid}`), {
    storage_used: used,
    storage_breakdown: breakdown,
    storage_backfilledAt: Date.now()
  });
  return getStorageSummary(uid, { skipBackfill: true });
}

export async function getStorageSummary(uid, opts = {}) {
  if (!opts.skipBackfill) await ensureStorageBackfill(uid).catch(() => null);
  const user = await loadUser(uid).catch(() => null);
  const quota = await getQuota(uid);
  const used = Number(user?.storage_used) || 0;
  const breakdown = normalizeStorageBreakdown(user?.storage_breakdown || {});
  return {
    used,
    quota,
    free: Math.max(0, quota - used),
    tier: user?.quota_tier || "free",
    breakdown
  };
}

export async function requestMoreStorage(uid, username, message) {
  const summary = await getStorageSummary(uid).catch(() => null);
  await push(ref(db, "admin_alerts"), {
    type: "storage-request",
    uid,
    username,
    message: String(message || "").slice(0, 1000),
    used: summary?.used || 0,
    quota: summary?.quota || QUOTA_FREE_BYTES,
    ts: Date.now()
  });
}

export async function setQuotaTierByAdmin(adminUid, targetUid, tier, reason = "Storage quota changed") {
  if (!["free", "trusted"].includes(tier)) throw new Error("Quota tier must be free or trusted.");
  const before = (await loadUser(targetUid))?.quota_tier || "free";
  await writeAdminAudit(adminUid, "set-quota-tier", targetUid, reason, before, tier);
  await update(ref(db, `users/${targetUid}`), { quota_tier: tier });
}

function normalizeStorageBreakdown(raw = {}) {
  const keys = ["cloud", "tube", "tunes", "sites", "games", "apps", "extensions", "other"];
  const out = {};
  for (const key of keys) out[key] = Number(raw[key]) || 0;
  return out;
}

async function computeStorageBreakdown(uid) {
  const breakdown = normalizeStorageBreakdown();
  const [cloudSnap, tubeSnap, tuneSnap, siteSnap, gameSnap, appSnap, extSnap] = await Promise.all([
    get(ref(db, `cloud-files/${uid}`)),
    get(ref(db, "tubes")),
    get(ref(db, "tunes")),
    get(ref(db, "sites")),
    get(ref(db, "games")),
    get(ref(db, "apps")),
    get(ref(db, "extensions"))
  ]);

  cloudSnap.forEach((c) => { breakdown.cloud += Number(c.val()?.size) || 0; });

  const blobLookups = [];
  tubeSnap.forEach((c) => {
    const v = c.val();
    if (v?.authorUid !== uid) return;
    const known = Number(v.size) || 0;
    if (known) breakdown.tube += known;
    else blobLookups.push(get(ref(db, `tube-blobs/${c.key}`)).then((snap) => { breakdown.tube += dataUrlByteSize(snap.val()); }));
  });
  tuneSnap.forEach((c) => {
    const v = c.val();
    if (v?.ownerUid !== uid) return;
    const known = Number(v.size) || 0;
    if (known) breakdown.tunes += known;
    else blobLookups.push(get(ref(db, `tune-blobs/${c.key}`)).then((snap) => { breakdown.tunes += dataUrlByteSize(snap.val()); }));
  });
  await Promise.all(blobLookups);

  siteSnap.forEach((c) => {
    const v = c.val();
    if ((v?.storageUid || v?.owner) === uid) breakdown.sites += Number(v.storageSize) || filesByteSize(v.files || {});
  });
  gameSnap.forEach((c) => {
    const v = c.val();
    if (v?.authorUid === uid) breakdown.games += Number(v.storageSize) || byteSize(v.code || "") + byteSize(v.thumb || "");
  });
  appSnap.forEach((c) => {
    const v = c.val();
    if (v?.authorUid === uid) breakdown.apps += Number(v.storageSize) || byteSize(v.code || "");
  });
  extSnap.forEach((c) => {
    const v = c.val();
    if (v?.authorUid === uid) breakdown.extensions += Number(v.storageSize) || byteSize(v.code || "");
  });
  return breakdown;
}

function byteSize(value) {
  if (value == null) return 0;
  if (typeof Blob !== "undefined") return new Blob([typeof value === "string" ? value : JSON.stringify(value)]).size;
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

function filesByteSize(files = {}) {
  return Object.values(files || {}).reduce((sum, content) => sum + byteSize(content || ""), 0);
}

function dataUrlByteSize(value) {
  const dataUrl = String(value || "");
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return byteSize(dataUrl);
  const body = dataUrl.slice(comma + 1);
  if (dataUrl.slice(0, comma).includes(";base64")) {
    const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((body.length * 3) / 4) - padding);
  }
  try { return new TextEncoder().encode(decodeURIComponent(body)).length; }
  catch { return byteSize(body); }
}

async function bumpAchievement(uid, key, amount = 1) {
  try {
    const mod = await import("./achievements.js");
    await mod.bumpCounterForUser(uid, key, amount);
  } catch (err) {
    console.warn("Achievement counter skipped:", key, err);
  }
}

async function unlockAchievement(uid, id) {
  try {
    const mod = await import("./achievements.js");
    await mod.unlockDirectForUser(uid, id);
  } catch (err) {
    console.warn("Achievement unlock skipped:", id, err);
  }
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
  const existingStorageUid = existing?.storageUid || existing?.owner || owner;
  const storageUid = owner;
  const oldSize = existingStorageUid === storageUid ? (Number(existing?.storageSize) || filesByteSize(existing?.files || {})) : 0;
  const newSize = filesByteSize(files || {});
  const added = Math.max(0, newSize - oldSize);
  if (added) await trackUpload(storageUid, added, "sites");
  try {
    await set(ref(db, `sites/${d}`), {
      domain: d,
      owner: existing?.owner || owner,
      storageUid,
      files,
      description: description || existing?.description || "",
      collaborators: existing?.collaborators || {},
      storageSize: newSize,
      updatedAt: serverTimestamp(),
      createdAt: existing?.createdAt || serverTimestamp()
    });
    if (newSize < oldSize) await trackDelete(storageUid, oldSize - newSize, "sites");
    await bumpAchievement(storageUid, "sites_published");
  } catch (err) {
    if (added) await trackDelete(storageUid, added, "sites").catch(() => {});
    throw err;
  }
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

const DEFAULT_WORDLISTS = {
  hardBlock: [],
  softFlag: ["nsfw"],
  rateLimits: { msgsPerSecond: 5, flagsPer5min: 10 }
};
let moderationLists = DEFAULT_WORDLISTS;
let moderationHooked = false;
const localRate = new Map();

function ensureModerationHook() {
  if (moderationHooked) return;
  moderationHooked = true;
  onValue(ref(db, "moderation/wordlists"), (snap) => {
    moderationLists = normalizeWordlists(snap.val());
  }, () => {
    moderationLists = DEFAULT_WORDLISTS;
  });
}

function normalizeWordlists(raw = {}) {
  return {
    hardBlock: Array.isArray(raw.hardBlock) ? raw.hardBlock : DEFAULT_WORDLISTS.hardBlock,
    softFlag: Array.isArray(raw.softFlag) ? raw.softFlag : DEFAULT_WORDLISTS.softFlag,
    rateLimits: {
      ...DEFAULT_WORDLISTS.rateLimits,
      ...(raw.rateLimits || {})
    }
  };
}

function termMatches(text, term) {
  const source = String(term || "").trim();
  if (!source) return false;
  if (source.startsWith("/") && source.lastIndexOf("/") > 0) {
    const lastSlash = source.lastIndexOf("/");
    const pattern = source.slice(1, lastSlash);
    const flags = source.slice(lastSlash + 1) || "i";
    try {
      return new RegExp(pattern, flags.includes("i") ? flags : flags + "i").test(text);
    } catch {
      return false;
    }
  }
  return text.toLowerCase().includes(source.toLowerCase());
}

function trackRate(uid, flagged) {
  const now = Date.now();
  const entry = localRate.get(uid) || { recent: [], flags: [] };
  entry.recent = entry.recent.filter((ts) => now - ts < 1000);
  entry.flags = entry.flags.filter((ts) => now - ts < 5 * 60 * 1000);
  entry.recent.push(now);
  if (flagged) entry.flags.push(now);
  localRate.set(uid, entry);
  return entry;
}

// Hard-coded username blocklist. These accounts are silently blocked from
// sending messages anywhere (channels, DMs, server channels, BlizzTube
// comments). They can still sign in and browse — only their writes drop.
const BANNED_USERNAMES = new Set(["blud mustard", "blud_mustard", "bludmustard"]);

export async function moderateMessage(text, context) {
  ensureModerationHook();
  const clean = String(text || "");

  // Permanent username blocklist takes priority over everything.
  const usernameKey = (context.username || "").toLowerCase().trim();
  if (usernameKey && (BANNED_USERNAMES.has(usernameKey) || BANNED_USERNAMES.has(usernameKey.replace(/\s+/g, "")))) {
    await push(ref(db, "admin_alerts"), {
      type: "username-ban-attempt",
      uid: context.uid,
      username: context.username,
      scope: context.scope,
      text: clean,
      ts: Date.now()
    }).catch(() => {});
    return { ok: false, reason: "blocked", reasons: ["Account is banned from messaging."] };
  }

  const hardReasons = moderationLists.hardBlock.filter((term) => termMatches(clean, term));
  const softReasons = moderationLists.softFlag.filter((term) => termMatches(clean, term));
  const rate = trackRate(context.uid, hardReasons.length > 0 || softReasons.length > 0);
  const maxPerSecond = Number(moderationLists.rateLimits?.msgsPerSecond || 5);
  const maxFlags = Number(moderationLists.rateLimits?.flagsPer5min || 10);

  if (rate.recent.length > maxPerSecond) {
    await push(ref(db, "admin_alerts"), {
      type: "rate-limit",
      uid: context.uid,
      username: context.username,
      scope: context.scope,
      reason: "too-many-messages",
      ts: Date.now()
    }).catch(() => {});
    return { ok: false, reason: "rate-limit" };
  }

  if (hardReasons.length > 0) {
    await push(ref(db, "admin_alerts"), {
      type: "hard-block",
      uid: context.uid,
      username: context.username,
      scope: context.scope,
      text: clean,
      reasons: hardReasons,
      ts: Date.now()
    }).catch(() => {});
    return { ok: false, reason: "blocked", reasons: hardReasons };
  }

  if (rate.flags.length > maxFlags) {
    await update(ref(db, `users/${context.uid}/timeout`), {
      until: Date.now() + 60 * 60 * 1000,
      reason: "Repeated flagged content",
      by: "auto-mod"
    }).catch(() => {});
    await push(ref(db, "admin_alerts"), {
      type: "auto-timeout",
      uid: context.uid,
      username: context.username,
      scope: context.scope,
      reason: "flags-per-5min",
      ts: Date.now()
    }).catch(() => {});
    return { ok: false, reason: "blocked", reasons: ["Repeated flagged content"] };
  }

  if (softReasons.length > 0) {
    return { ok: true, flagged: true, reasons: softReasons };
  }
  return { ok: true, flagged: false, reasons: [] };
}

async function pushModeratedMessage(path, payload, context) {
  const result = await moderateMessage(payload.text, context);
  if (!result.ok) {
    throw new Error("Your message couldn't be sent. It may have violated community guidelines.");
  }
  const rowRef = push(ref(db, path));
  const next = {
    ...payload,
    ts: payload.ts || Date.now()
  };
  if (result.flagged) {
    next.moderation = { status: "review", reasons: result.reasons };
  }
  await set(rowRef, next);
  if (result.flagged) {
    const id = rowRef.key;
    await set(ref(db, `mod_queue/${encodeKey(context.scope)}/${id}`), {
      id,
      scope: context.scope,
      messagePath: `${path}/${id}`,
      text: payload.text,
      senderUid: context.uid,
      senderUsername: context.username,
      reasons: result.reasons,
      ts: next.ts
    }).catch(() => {});
  }
  return rowRef.key;
}

export function subscribeChannel(channelId, callback) {
  const q = query(ref(db, `messages/channels/${channelId}`), orderByChild("ts"), limitToLast(200));
  const handler = onChildAdded(q, (snap) => callback({ id: snap.key, ...snap.val() }));
  return () => off(q, "child_added", handler);
}

export async function sendChannelMessage(channelId, uid, username, text) {
  const id = await pushModeratedMessage(`messages/channels/${channelId}`, {
    uid, username, text, ts: Date.now()
  }, { uid, username, scope: `channel:${channelId}` });
  await bumpAchievement(uid, "messages_sent");
  return id;
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
  const id = await pushModeratedMessage(`messages/dms/${key}`, {
    uid: fromUid, username: fromUsername, text, ts: Date.now()
  }, { uid: fromUid, username: fromUsername, scope: `dm:${key}` });
  await bumpAchievement(fromUid, "messages_sent");
  await bumpAchievement(fromUid, "dms_sent");
  return id;
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

export async function publishGame(authorUid, authorUsername, { title, description, code, thumb, multiplayer = false }) {
  const id = push(ref(db, `games`)).key;
  const storageSize = byteSize(code || "") + byteSize(thumb || "");
  await trackUpload(authorUid, storageSize, "games");
  try {
    await set(ref(db, `games/${id}`), {
    id, title, description, code,
    thumb: thumb || "🎮",
    multiplayer: !!multiplayer,
    storageSize,
    authorUid, authorUsername,
    createdAt: serverTimestamp()
  });
  } catch (err) {
    await trackDelete(authorUid, storageSize, "games").catch(() => {});
    throw err;
  }
  await bumpAchievement(authorUid, "games_published");
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

export async function setUserStatus(uid, status) {
  if (!["online", "idle", "dnd", "invisible", "offline"].includes(status)) {
    throw new Error("Invalid status.");
  }
  await update(ref(db, `users/${uid}`), { status });
}

// --------------------------------------------------------------------------
// Blizzard Tube — video entries + comments
// --------------------------------------------------------------------------
// Firebase Realtime Database caps a single write at ~16 MB. We use 20 MB
// here as the "stream recording" ceiling — the upload path chunks into
// multiple RTDB writes when the file is bigger than ~10 MB to stay safe.
export const TUBE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB max video upload
const TUBE_ACCEPTED_EXTS = [".mp4", ".webm", ".ogg", ".mov"];

export async function listTubes() {
  const snap = await get(ref(db, `tubes`));
  const out = [];
  snap.forEach((c) => out.push({ id: c.key, ...c.val() }));
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// Upload a video file. `meta` may include { title, description, tags: [], thumb }.
// `tags` is an array of lowercase strings.
export async function publishTubeFile(authorUid, authorUsername, file, meta = {}) {
  const mime = inferVideoMime(file);
  if (!mime) {
    throw new Error("Unsupported video type. Use .mp4, .webm, .ogg, or .mov.");
  }
  if (file.size > TUBE_MAX_BYTES) {
    throw new Error(`Video too large (${(file.size/1024/1024).toFixed(1)} MB). Limit is ${TUBE_MAX_BYTES/1024/1024} MB.`);
  }
  const id = push(ref(db, `tubes`)).key;
  await trackUpload(authorUid, file.size, "tube");
  try {
    let dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    dataUrl = normalizeDataUrlMime(dataUrl, mime);
    if (dataUrl.length > 9.5 * 1024 * 1024) {
      throw new Error("Video is too large after browser encoding. Try a shorter or more compressed clip.");
    }
    await set(ref(db, `tubes/${id}`), {
      id,
      title: meta.title || file.name,
      description: meta.description || "",
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      thumb: meta.thumb || "",
      mime,
      size: file.size,
      kind: "upload",
      authorUid, authorUsername,
      views: 0,
      createdAt: Date.now()
    });
    await set(ref(db, `tube-blobs/${id}`), dataUrl);
  } catch (err) {
    await trackDelete(authorUid, file.size, "tube").catch(() => {});
    await remove(ref(db, `tubes/${id}`)).catch(() => {});
    await remove(ref(db, `tube-blobs/${id}`)).catch(() => {});
    throw err;
  }
  await bumpAchievement(authorUid, "tubes_published");
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
  const tube = (await get(ref(db, `tubes/${id}`))).val();
  await remove(ref(db, `tubes/${id}`));
  await remove(ref(db, `tube-blobs/${id}`));
  if (tube?.authorUid && tube?.size) await trackDelete(tube.authorUid, tube.size, "tube").catch(() => {});
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
  const id = await pushModeratedMessage(`tubeComments/${tubeId}`, {
    uid, username, text, ts: Date.now()
  }, { uid, username, scope: `tube:${tubeId}` });
  await bumpAchievement(uid, "messages_sent");
  return id;
}

function inferVideoMime(file) {
  const name = (file?.name || "").toLowerCase();
  if (file?.type?.startsWith("video/")) return file.type;
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".ogg")) return "video/ogg";
  if (name.endsWith(".mov")) return "video/quicktime";
  return TUBE_ACCEPTED_EXTS.some((ext) => name.endsWith(ext)) ? "video/mp4" : "";
}

function normalizeDataUrlMime(dataUrl, mime) {
  const value = String(dataUrl || "");
  if (!value.startsWith("data:")) return value;
  return value.replace(/^data:[^;,]+([;,])/, `data:${mime}$1`);
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
  await bumpAchievement(ownerUid, "servers_created");
  await bumpAchievement(ownerUid, "servers_joined");
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
  await bumpAchievement(uid, "servers_joined");
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
  const id = await pushModeratedMessage(`serverMessages/${serverId}/${channelId}`, {
    uid, username, text, ts: Date.now()
  }, { uid, username, scope: `server:${serverId}:${channelId}` });
  await bumpAchievement(uid, "messages_sent");
  return id;
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
  const id = push(ref(db, `cloud-files/${uid}`)).key;
  const path = (parentPath.replace(/\/$/, "") + "/" + file.name);
  await trackUpload(uid, file.size, "cloud");
  try {
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
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
  } catch (err) {
    await trackDelete(uid, file.size, "cloud").catch(() => {});
    await remove(ref(db, `cloud-files/${uid}/${id}`)).catch(() => {});
    await remove(ref(db, `cloud-blobs/${uid}/${id}`)).catch(() => {});
    throw err;
  }
  await bumpAchievement(uid, "cloud_files_uploaded");
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
  await trackUpload(uid, bytes, "cloud");
  try {
    await set(ref(db, `cloud-files/${uid}/${id}`), {
      id, path, parent, name,
      size: bytes,
      type: "text/plain",
      uploadedAt: Date.now(),
      ownerUid: uid,
      sharedWith: {}
    });
    await set(ref(db, `cloud-blobs/${uid}/${id}`), dataUrl);
  } catch (err) {
    await trackDelete(uid, bytes, "cloud").catch(() => {});
    await remove(ref(db, `cloud-files/${uid}/${id}`)).catch(() => {});
    await remove(ref(db, `cloud-blobs/${uid}/${id}`)).catch(() => {});
    throw err;
  }
  await bumpAchievement(uid, "cloud_files_uploaded");
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
  if (f?.size) await trackDelete(ownerUid, f.size, "cloud").catch(() => {});
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
  const storageSize = byteSize(code || "") + byteSize(glyph || "");
  await trackUpload(authorUid, storageSize, "apps");
  try {
    await set(ref(db, `apps/${id}`), {
    id, title, description, code, glyph: glyph || "📦",
    storageSize,
    authorUid, authorUsername, createdAt: Date.now()
  });
  } catch (err) {
    await trackDelete(authorUid, storageSize, "apps").catch(() => {});
    throw err;
  }
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
  await bumpAchievement(ownerUid, "streams_started");
  return id;
}
export async function endStream(streamId) {
  const before = (await get(ref(db, `streams/${streamId}`))).val();
  await update(ref(db, `streams/${streamId}`), { live: false, endedAt: Date.now() });
  if (before?.ownerUid && before?.startedAt) {
    const minutes = Math.max(1, Math.floor((Date.now() - before.startedAt) / 60000));
    await bumpAchievement(before.ownerUid, "stream_minutes", minutes);
  }
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

// ---------------------------------------------------------------------------
// Bulk message deletion — used when a spammer floods channels or DMs and you
// need to clear their wake. Walks every channel, server-channel, DM thread,
// and BlizzTube comment tree, deleting messages where uid matches targetUid.
// Returns a count of how many were deleted (best-effort).
// ---------------------------------------------------------------------------
export async function adminBulkDeleteUserMessages(adminUid, targetUid, reason = "") {
  let deleted = 0;
  const walk = async (path) => {
    const snap = await get(ref(db, path));
    const removes = [];
    snap.forEach((c) => {
      const v = c.val();
      if (v && v.uid === targetUid) removes.push(remove(ref(db, `${path}/${c.key}`)));
    });
    deleted += removes.length;
    await Promise.all(removes);
  };
  // Public channels: messages/channels/{cid}/{mid}
  const channelsSnap = await get(ref(db, "messages/channels"));
  for (const cid of Object.keys(channelsSnap.val() || {})) {
    await walk(`messages/channels/${cid}`);
  }
  // DM threads: messages/dms/{pair}/{mid}
  const dmsSnap = await get(ref(db, "messages/dms"));
  for (const pair of Object.keys(dmsSnap.val() || {})) {
    await walk(`messages/dms/${pair}`);
  }
  // Server channels: serverMessages/{sid}/{cid}/{mid}
  const serversSnap = await get(ref(db, "serverMessages"));
  for (const sid of Object.keys(serversSnap.val() || {})) {
    const channels = await get(ref(db, `serverMessages/${sid}`));
    for (const cid of Object.keys(channels.val() || {})) {
      await walk(`serverMessages/${sid}/${cid}`);
    }
  }
  // BlizzTube comments: tubeComments/{vid}/{cid}
  const tubeSnap = await get(ref(db, "tubeComments"));
  for (const vid of Object.keys(tubeSnap.val() || {})) {
    await walk(`tubeComments/${vid}`);
  }
  // Stream chats: stream-chat/{sid}/{mid}
  const streamChatSnap = await get(ref(db, "stream-chat"));
  for (const sid of Object.keys(streamChatSnap.val() || {})) {
    await walk(`stream-chat/${sid}`);
  }
  // Audit entry so the trail exists.
  await push(ref(db, "admin_audit_log"), {
    action: "bulk-delete-messages",
    adminUid, targetUid, reason,
    deleted, ts: Date.now()
  }).catch(() => {});
  return deleted;
}

// ---------------------------------------------------------------------------
// Follow-streamers: a user can follow another user's channel. We store the
// per-follower index (`stream-follows/{followerUid}/{streamerUid} = true`)
// so the notifier knows who to alert when {streamerUid} goes live.
// ---------------------------------------------------------------------------
export async function followStreamer(followerUid, streamerUid) {
  if (!followerUid || !streamerUid || followerUid === streamerUid) return;
  await set(ref(db, `stream-follows/${followerUid}/${streamerUid}`), true);
}
export async function unfollowStreamer(followerUid, streamerUid) {
  await remove(ref(db, `stream-follows/${followerUid}/${streamerUid}`));
}
export function subscribeMyFollows(uid, cb) {
  const r = ref(db, `stream-follows/${uid}`);
  const handler = onValue(r, (snap) => {
    const out = {};
    snap.forEach((c) => { out[c.key] = c.val(); });
    cb(out);
  });
  return () => off(r, "value", handler);
}
export async function isFollowing(followerUid, streamerUid) {
  const snap = await get(ref(db, `stream-follows/${followerUid}/${streamerUid}`));
  return !!snap.val();
}

// ---------------------------------------------------------------------------
// Voice calls (1-on-1 in GuildWire DMs). Entirely Firebase-signaled WebRTC —
// no third-party APIs. A call is identified by an opaque callId. The shape:
//
//   calls/{callId}: { fromUid, fromUsername, toUid, status, startedAt, endedAt }
//   calls/{callId}/offer:  RTCSessionDescription from the caller
//   calls/{callId}/answer: RTCSessionDescription from the callee
//   calls/{callId}/ice/{caller|callee}/{push}: ICE candidates
//
//   incoming-calls/{uid}/{callId} = { from, fromUsername, ts } — invitation list
//   per-user so they get notified.
// ---------------------------------------------------------------------------
export async function createCall(fromUid, fromUsername, toUid) {
  const callId = push(ref(db, "calls")).key;
  const now = Date.now();
  await set(ref(db, `calls/${callId}`), {
    id: callId, fromUid, fromUsername, toUid,
    status: "ringing", startedAt: now
  });
  // Put it in the callee's incoming list so subscribers fire.
  await set(ref(db, `incoming-calls/${toUid}/${callId}`), {
    from: fromUid, fromUsername, ts: now
  });
  return callId;
}
export function subscribeIncomingCalls(uid, cb) {
  const r = ref(db, `incoming-calls/${uid}`);
  const handler = onChildAdded(r, (snap) => cb({ callId: snap.key, ...snap.val() }));
  return () => off(r, "child_added", handler);
}
export async function dismissIncomingCall(uid, callId) {
  await remove(ref(db, `incoming-calls/${uid}/${callId}`));
}
export function subscribeCall(callId, cb) {
  const r = ref(db, `calls/${callId}`);
  const handler = onValue(r, (snap) => cb(snap.val()));
  return () => off(r, "value", handler);
}
export async function setCallStatus(callId, status) {
  const patch = { status };
  if (status === "ended" || status === "declined") patch.endedAt = Date.now();
  await update(ref(db, `calls/${callId}`), patch);
}
export async function setCallOffer(callId, sdp)  { await set(ref(db, `calls/${callId}/offer`),  sdp); }
export async function setCallAnswer(callId, sdp) { await set(ref(db, `calls/${callId}/answer`), sdp); }
export async function pushCallIce(callId, side, candidate) {
  await push(ref(db, `calls/${callId}/ice/${side}`), candidate);
}
export function subscribeCallIce(callId, side, cb) {
  const r = ref(db, `calls/${callId}/ice/${side}`);
  const handler = onChildAdded(r, (snap) => cb(snap.val()));
  return () => off(r, "child_added", handler);
}
export function subscribeCallAnswer(callId, cb) {
  const r = ref(db, `calls/${callId}/answer`);
  const handler = onValue(r, (snap) => cb(snap.val()));
  return () => off(r, "value", handler);
}
export function subscribeCallOffer(callId, cb) {
  const r = ref(db, `calls/${callId}/offer`);
  const handler = onValue(r, (snap) => cb(snap.val()));
  return () => off(r, "value", handler);
}
// Append-only call history. Stored separately per participant so each user
// can list their own without needing a server-side join.
export async function logCall(uid, entry) {
  if (!uid) return;
  await push(ref(db, `call-logs/${uid}`), {
    ts: Date.now(),
    ...entry
  });
}
export async function listCallLogs(uid, limit = 50) {
  const snap = await get(query(ref(db, `call-logs/${uid}`), orderByChild("ts"), limitToLast(limit)));
  const out = [];
  snap.forEach((c) => out.push({ id: c.key, ...c.val() }));
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Pinned-app sync — mirrors the user's pinned-taskbar list across devices.
// Same shape as desktop-icon positions, stored under `pinned-apps/{uid}`.
// ---------------------------------------------------------------------------
export function subscribePinnedApps(uid, cb) {
  const r = ref(db, `pinned-apps/${uid}`);
  const handler = onValue(r, (snap) => cb(Array.isArray(snap.val()) ? snap.val() : []));
  return () => off(r, "value", handler);
}
export async function savePinnedApps(uid, list) {
  await set(ref(db, `pinned-apps/${uid}`), Array.isArray(list) ? list : []);
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
export const TUNE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB audio per track
export const TUNE_ACCEPTED_EXTS = [".mp3", ".wav", ".flac", ".ogg", ".m4a"];

export async function publishTune(ownerUid, ownerUsername, file, meta) {
  const mime = inferAudioMime(file);
  if (!mime) {
    throw new Error("Unsupported audio type. Use .mp3, .wav, .flac, .ogg, or .m4a.");
  }
  if (file.size > TUNE_MAX_BYTES) {
    throw new Error(`Track too large (${(file.size/1024/1024).toFixed(1)} MB). Limit is ${TUNE_MAX_BYTES/1024/1024} MB.`);
  }
  const id = push(ref(db, `tunes`)).key;
  await trackUpload(ownerUid, file.size, "tunes");
  try {
    let dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });
    dataUrl = normalizeDataUrlMime(dataUrl, mime);
    if (dataUrl.length > 9.5 * 1024 * 1024) {
      throw new Error("Track is too large after browser encoding. Try a shorter or more compressed file.");
    }
    await set(ref(db, `tunes/${id}`), {
      id,
      ownerUid, ownerUsername,
      title: meta.title || file.name,
      artist: meta.artist || ownerUsername,
      kind: meta.kind || "music",   // "music" | "podcast"
      cover: meta.cover || "",
      size: file.size,
      mime,
      plays: 0,
      likes: 0,
      createdAt: Date.now()
    });
    await set(ref(db, `tune-blobs/${id}`), dataUrl);
  } catch (err) {
    await trackDelete(ownerUid, file.size, "tunes").catch(() => {});
    await remove(ref(db, `tunes/${id}`)).catch(() => {});
    await remove(ref(db, `tune-blobs/${id}`)).catch(() => {});
    throw err;
  }
  await bumpAchievement(ownerUid, "tunes_uploaded");
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
  const tune = (await get(ref(db, `tunes/${id}`))).val();
  await remove(ref(db, `tunes/${id}`));
  await remove(ref(db, `tune-blobs/${id}`));
  if (tune?.ownerUid && tune?.size) await trackDelete(tune.ownerUid, tune.size, "tunes").catch(() => {});
}
export async function incrementTunePlays(id) {
  const r = ref(db, `tunes/${id}/plays`);
  const cur = (await get(r)).val() || 0;
  await set(r, cur + 1);
}

function inferAudioMime(file) {
  const name = (file?.name || "").toLowerCase();
  if (file?.type?.startsWith("audio/")) return file.type;
  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".flac")) return "audio/flac";
  if (name.endsWith(".ogg")) return "audio/ogg";
  if (name.endsWith(".m4a")) return "audio/mp4";
  return "";
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
  await bumpAchievement(uid, "playlists_created");
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
  const storageSize = byteSize(code || "") + byteSize(glyph || "");
  await trackUpload(authorUid, storageSize, "extensions");
  try {
    await set(ref(db, `extensions/${id}`), {
    id, name, description, code,
    glyph: glyph || "🧩",
    storageSize,
    authorUid, authorUsername,
    installs: 0,
    createdAt: Date.now()
  });
  } catch (err) {
    await trackDelete(authorUid, storageSize, "extensions").catch(() => {});
    throw err;
  }
  await bumpAchievement(authorUid, "extensions_published");
  return id;
}
export async function getExtension(id) { return (await get(ref(db, `extensions/${id}`))).val(); }
export async function deleteExtension(id) {
  const ext = await getExtension(id);
  await remove(ref(db, `extensions/${id}`));
  if (ext?.authorUid) await trackDelete(ext.authorUid, Number(ext.storageSize) || byteSize(ext.code || ""), "extensions").catch(() => {});
}

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
  await bumpAchievement(reporterUid, "reports_filed");
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

export async function setReportStatusByAdmin(adminUid, id, status, reason = "Report review") {
  const before = (await get(ref(db, `reports/${id}`))).val();
  await writeAdminAudit(adminUid, "set-report-status", before?.reporterUid || "", reason, before, { ...before, status });
  await setReportStatus(id, status);
}

// --------------------------------------------------------------------------
// Roles, moderation queues, and admin actions.
// --------------------------------------------------------------------------
export function isPrivilegedRole(userRecord, minimum = "mod") {
  const rank = { user: 0, mod: 1, admin: 2 };
  return (rank[userRecord?.role || "user"] || 0) >= (rank[minimum] || 0);
}

export async function getUserRole(uid) {
  const user = await loadUser(uid);
  return user?.role || "user";
}

export async function requireRole(uid, minimum = "mod") {
  const user = await loadUser(uid);
  if (!isPrivilegedRole(user, minimum)) {
    throw new Error(minimum === "admin" ? "Admin access required." : "Moderator access required.");
  }
  return user;
}

export async function acknowledgeWarnings(uid, warningIds) {
  const updates = {};
  for (const id of warningIds || []) {
    updates[`users/${uid}/warnings/${id}/acknowledgedAt`] = Date.now();
  }
  if (Object.keys(updates).length) await update(ref(db), updates);
}

async function audit(path, actorUid, action, targetUid, reason, before, after) {
  const row = push(ref(db, path));
  await set(row, {
    id: row.key,
    actorUid,
    action,
    targetUid: targetUid || "",
    reason: reason || "",
    before: before ?? null,
    after: after ?? null,
    ts: Date.now()
  });
  return row.key;
}

export async function writeAdminAudit(adminUid, action, targetUid, reason, before, after) {
  return audit("admin_audit_log", adminUid, action, targetUid, reason, before, after);
}

export async function writeModAudit(modUid, action, targetUid, reason, before, after) {
  return audit("mod_audit_log", modUid, action, targetUid, reason, before, after);
}

export async function listAuditLog(path = "admin_audit_log") {
  const snap = await get(ref(db, path));
  const out = [];
  snap.forEach((c) => out.push({ id: c.key, ...c.val() }));
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

export async function setUserRoleByAdmin(adminUid, targetUid, role, reason = "") {
  if (!["user", "mod", "admin"].includes(role)) throw new Error("Role must be user, mod, or admin.");
  const before = await loadUser(targetUid);
  await writeAdminAudit(adminUid, "set-role", targetUid, reason, before?.role || "user", role);
  await update(ref(db, `users/${targetUid}`), { role });
  if (role === "mod") await unlockAchievement(targetUid, "mod_appointed");
}

export async function issueWarning(actorUid, targetUid, text, reason = "Warning") {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("Warning text is required.");
  const row = push(ref(db, `users/${targetUid}/warnings`));
  const warning = {
    id: row.key,
    text: clean,
    by: actorUid,
    ts: Date.now(),
    acknowledgedAt: 0
  };
  await writeModAudit(actorUid, "warn", targetUid, reason, null, warning).catch(() => {});
  await set(row, warning);
  return row.key;
}

export async function setUserTimeoutByAdmin(adminUid, targetUid, until, reason = "") {
  const before = (await loadUser(targetUid))?.timeout || null;
  const timeout = { until, reason, by: adminUid, ts: Date.now() };
  await writeAdminAudit(adminUid, "timeout", targetUid, reason, before, timeout);
  await update(ref(db, `users/${targetUid}`), { timeout });
}

export async function setUserBanByAdmin(adminUid, targetUid, banned, reason = "") {
  const before = (await loadUser(targetUid))?.banned || false;
  await writeAdminAudit(adminUid, banned ? "ban" : "unban", targetUid, reason, before, !!banned);
  await update(ref(db, `users/${targetUid}`), { banned: !!banned });
}

export async function setAppBanByAdmin(adminUid, targetUid, appId, banned, reason = "") {
  const before = (await loadUser(targetUid))?.appBans?.[appId] || false;
  await writeAdminAudit(adminUid, banned ? "app-ban" : "app-unban", targetUid, reason, before, !!banned);
  await update(ref(db, `users/${targetUid}/appBans`), { [appId]: !!banned });
  if (banned) await wipeAppContent(adminUid, targetUid, appId, reason);
}

export async function listModQueue() {
  const snap = await get(ref(db, "mod_queue"));
  const out = [];
  snap.forEach((scopeSnap) => {
    scopeSnap.forEach((itemSnap) => out.push({ queueScope: scopeSnap.key, queueId: itemSnap.key, ...itemSnap.val() }));
  });
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

export async function approveModQueueItem(modUid, item) {
  if (!item?.messagePath) return;
  await update(ref(db, item.messagePath), { moderation: { status: "approved", reviewedBy: modUid, reviewedAt: Date.now() } });
  await remove(ref(db, `mod_queue/${item.queueScope}/${item.queueId}`));
  await writeModAudit(modUid, "approve", item.senderUid, "Approved flagged content", item, null).catch(() => {});
}

export async function rejectModQueueItem(modUid, item) {
  if (!item?.messagePath) return;
  await update(ref(db, item.messagePath), { hidden: true, moderation: { status: "rejected", reviewedBy: modUid, reviewedAt: Date.now() } });
  await remove(ref(db, `mod_queue/${item.queueScope}/${item.queueId}`));
  await writeModAudit(modUid, "reject", item.senderUid, "Rejected flagged content", item, null).catch(() => {});
}

export async function requestTimeoutReview(modUid, targetUid, minutes, reason = "Flagged content") {
  const alert = {
    type: "timeout-request",
    modUid,
    targetUid,
    minutes,
    reason,
    ts: Date.now()
  };
  await push(ref(db, "admin_alerts"), alert);
  await writeModAudit(modUid, "request-timeout", targetUid, reason, null, alert).catch(() => {});
}

export async function saveModerationWordlists(adminUid, wordlists) {
  const before = normalizeWordlists((await get(ref(db, "moderation/wordlists"))).val());
  const after = normalizeWordlists(wordlists);
  await writeAdminAudit(adminUid, "moderation-wordlists", "", "Updated moderation word lists", before, after);
  await set(ref(db, "moderation/wordlists"), after);
}

export function subscribeModerationWordlists(callback) {
  const r = ref(db, "moderation/wordlists");
  const handler = onValue(r, (snap) => callback(normalizeWordlists(snap.val())));
  return () => off(r, "value", handler);
}

async function wipeAppContent(adminUid, targetUid, appId, reason = "") {
  const id = String(appId || "").toLowerCase();
  const removals = [];
  const addRemoval = (path) => removals.push(remove(ref(db, path)).catch(() => {}));

  if (["tube", "tubes", "blizztube"].includes(id)) {
    const snap = await get(ref(db, "tubes"));
    snap.forEach((c) => {
      if (c.val()?.authorUid === targetUid) {
        addRemoval(`tubes/${c.key}`);
        addRemoval(`tube-blobs/${c.key}`);
      }
    });
  }
  if (["tunes", "music"].includes(id)) {
    const snap = await get(ref(db, "tunes"));
    snap.forEach((c) => {
      if (c.val()?.ownerUid === targetUid) {
        addRemoval(`tunes/${c.key}`);
        addRemoval(`tune-blobs/${c.key}`);
      }
    });
  }
  if (["messenger", "messages", "chat"].includes(id)) {
    const [msgSnap, serverMsgSnap] = await Promise.all([get(ref(db, "messages")), get(ref(db, "serverMessages"))]);
    msgSnap.child("channels").forEach((channelSnap) => {
      channelSnap.forEach((msg) => { if (msg.val()?.uid === targetUid) addRemoval(`messages/channels/${channelSnap.key}/${msg.key}`); });
    });
    msgSnap.child("dms").forEach((dmSnap) => {
      dmSnap.forEach((msg) => { if (msg.val()?.uid === targetUid) addRemoval(`messages/dms/${dmSnap.key}/${msg.key}`); });
    });
    serverMsgSnap.forEach((server) => {
      server.forEach((channel) => {
        channel.forEach((msg) => { if (msg.val()?.uid === targetUid) addRemoval(`serverMessages/${server.key}/${channel.key}/${msg.key}`); });
      });
    });
  }

  await Promise.all(removals);
  if (removals.length) {
    await writeAdminAudit(adminUid, "wipe-app-content", targetUid, `${appId}: ${reason}`, null, { removed: removals.length });
  }
}

export async function wipeUserContent(adminUid, targetUid, reason = "") {
  const updates = {};
  const removals = [];
  const addRemoval = (path) => removals.push(remove(ref(db, path)).catch(() => {}));

  const [tubeSnap, tuneSnap, siteSnap, gameSnap, extSnap, appSnap, msgSnap, serverMsgSnap, serverSnap] = await Promise.all([
    get(ref(db, "tubes")),
    get(ref(db, "tunes")),
    get(ref(db, "sites")),
    get(ref(db, "games")),
    get(ref(db, "extensions")),
    get(ref(db, "apps")),
    get(ref(db, "messages")),
    get(ref(db, "serverMessages")),
    get(ref(db, "servers"))
  ]);

  tubeSnap.forEach((c) => {
    if (c.val()?.authorUid === targetUid) {
      addRemoval(`tubes/${c.key}`);
      addRemoval(`tube-blobs/${c.key}`);
    }
  });
  tuneSnap.forEach((c) => {
    if (c.val()?.ownerUid === targetUid) {
      addRemoval(`tunes/${c.key}`);
      addRemoval(`tune-blobs/${c.key}`);
    }
  });
  siteSnap.forEach((c) => { if (c.val()?.owner === targetUid) addRemoval(`sites/${c.key}`); });
  gameSnap.forEach((c) => { if (c.val()?.authorUid === targetUid) addRemoval(`games/${c.key}`); });
  extSnap.forEach((c) => { if (c.val()?.authorUid === targetUid) addRemoval(`extensions/${c.key}`); });
  appSnap.forEach((c) => { if (c.val()?.authorUid === targetUid) addRemoval(`apps/${c.key}`); });

  msgSnap.child("channels").forEach((channelSnap) => {
    channelSnap.forEach((msg) => { if (msg.val()?.uid === targetUid) addRemoval(`messages/channels/${channelSnap.key}/${msg.key}`); });
  });
  msgSnap.child("dms").forEach((dmSnap) => {
    dmSnap.forEach((msg) => { if (msg.val()?.uid === targetUid) addRemoval(`messages/dms/${dmSnap.key}/${msg.key}`); });
  });
  serverMsgSnap.forEach((server) => {
    server.forEach((channel) => {
      channel.forEach((msg) => { if (msg.val()?.uid === targetUid) addRemoval(`serverMessages/${server.key}/${channel.key}/${msg.key}`); });
    });
  });
  serverSnap.forEach((server) => {
    if (server.child(`members/${targetUid}`).exists()) {
      updates[`servers/${server.key}/members/${targetUid}`] = null;
    }
  });

  if (Object.keys(updates).length) await update(ref(db), updates);
  await Promise.all(removals);
  await writeAdminAudit(adminUid, "wipe-content", targetUid, reason, null, { removed: removals.length });
}

export async function globalBanUser(adminUid, targetUid, username, reason = "") {
  const expected = String(username || "").trim().toLowerCase();
  const user = await loadUser(targetUid);
  if (!user || (user.username || "").toLowerCase() !== expected) {
    throw new Error("Typed username does not match the target account.");
  }
  await setUserBanByAdmin(adminUid, targetUid, true, reason);
  await wipeUserContent(adminUid, targetUid, reason);
  await push(ref(db, "admin_alerts"), {
    type: "auth-delete-needed",
    uid: targetUid,
    username: user.username,
    reason,
    by: adminUid,
    ts: Date.now()
  }).catch(() => {});
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
