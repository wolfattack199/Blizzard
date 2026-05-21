import {
  db, ref, get, set, update, remove, push, onValue, onChildAdded, onDisconnect, off
} from "./firebase.js";

const MAX_PLAYERS = 16;
const MAX_ROOM_STATE_BYTES = 1024 * 1024;
const MIN_SET_INTERVAL = 1000 / 30;
const lastSet = new Map();
const hostWatchers = new Map();

export async function joinMultiplayerRoom(user, opts = {}, fallbackGameId = "site") {
  if (!user?.uid) throw new Error("Sign in before joining multiplayer.");
  const gameId = safeId(opts.gameId || fallbackGameId || "game");
  const roomId = safeRoom(opts.roomId) || makeRoomId();
  const maxPlayers = Math.max(1, Math.min(MAX_PLAYERS, Number(opts.maxPlayers) || 8));
  await purgeIdleRooms(gameId);

  const roomPath = `game_rooms/${gameId}/${roomId}`;
  const metaSnap = await get(ref(db, `${roomPath}/meta`));
  if (!metaSnap.exists()) {
    await set(ref(db, `${roomPath}/meta`), {
      hostUid: user.uid,
      gameId,
      createdAt: Date.now(),
      touchedAt: Date.now(),
      maxPlayers,
      status: "open"
    });
  }

  const playersSnap = await get(ref(db, `${roomPath}/players`));
  const players = playersSnap.val() || {};
  if (!players[user.uid] && Object.keys(players).length >= maxPlayers) {
    throw new Error("That multiplayer room is full.");
  }
  const usedSlots = new Set(Object.values(players).map((p) => Number(p.slot)));
  let slot = players[user.uid]?.slot;
  if (!Number.isFinite(slot)) {
    slot = 0;
    while (usedSlots.has(slot)) slot++;
  }

  const player = { username: user.username || "player", slot, joinedAt: Date.now() };
  await set(ref(db, `${roomPath}/players/${user.uid}`), player);
  await update(ref(db, `${roomPath}/meta`), { touchedAt: Date.now(), maxPlayers });
  onDisconnect(ref(db, `${roomPath}/players/${user.uid}`)).remove().catch(() => {});
  watchHostMigration(gameId, roomId);
  purgeOldEvents(gameId, roomId).catch(() => {});

  const fresh = await get(ref(db, `game_rooms/${gameId}/${roomId}`));
  const room = fresh.val() || {};
  return {
    session: { gameId, roomId, uid: user.uid },
    publicRoom: publicRoom(roomId, room, user.uid)
  };
}

export async function leaveMultiplayerRoom(session) {
  if (!session) return;
  await remove(ref(db, `game_rooms/${session.gameId}/${session.roomId}/players/${session.uid}`));
  await electHost(session.gameId, session.roomId);
}

export async function setRoomState(session, key, value) {
  const safeKey = safePath(key);
  const throttleKey = `${session.gameId}/${session.roomId}/${session.uid}/${safeKey}`;
  const now = Date.now();
  const prev = lastSet.get(throttleKey) || 0;
  if (now - prev < MIN_SET_INTERVAL) {
    await wait(MIN_SET_INTERVAL - (now - prev));
  }
  lastSet.set(throttleKey, Date.now());

  const stateRef = ref(db, `game_rooms/${session.gameId}/${session.roomId}/state`);
  const current = (await get(stateRef)).val() || {};
  const next = structuredCloneSafe(current);
  assignPath(next, safeKey, value);
  if (byteSize(next) > MAX_ROOM_STATE_BYTES) {
    throw new Error("Room state is over the 1024 KB limit.");
  }
  await set(ref(db, `game_rooms/${session.gameId}/${session.roomId}/state/${safeKey}`), value);
  await update(ref(db, `game_rooms/${session.gameId}/${session.roomId}/meta`), { touchedAt: Date.now() });
}

export async function getRoomState(session, key = "") {
  const path = safePath(key);
  const snap = await get(ref(db, `game_rooms/${session.gameId}/${session.roomId}/state${path ? "/" + path : ""}`));
  return snap.val();
}

export function subscribeRoomState(session, key, cb) {
  const path = safePath(key);
  const r = ref(db, `game_rooms/${session.gameId}/${session.roomId}/state${path ? "/" + path : ""}`);
  const handler = onValue(r, (snap) => cb(snap.val()));
  return () => off(r, "value", handler);
}

export async function emitRoomEvent(session, type, data) {
  await push(ref(db, `game_rooms/${session.gameId}/${session.roomId}/events`), {
    type: String(type || "event").slice(0, 40),
    data: data ?? null,
    from: session.uid,
    ts: Date.now()
  });
}

export function subscribeRoomEvents(session, type, cb) {
  const r = ref(db, `game_rooms/${session.gameId}/${session.roomId}/events`);
  const handler = onChildAdded(r, (snap) => {
    const event = { id: snap.key, ...snap.val() };
    if (!type || event.type === type) cb(event);
  });
  return () => off(r, "child_added", handler);
}

function publicRoom(roomId, room, uid) {
  const players = Object.entries(room.players || {})
    .map(([playerUid, value]) => ({ uid: playerUid, ...value }))
    .sort((a, b) => (a.slot || 0) - (b.slot || 0));
  return {
    id: roomId,
    hostUid: room.meta?.hostUid || players[0]?.uid || uid,
    players,
    iAm: players.find((p) => p.uid === uid) || { uid, username: "player", slot: 0 }
  };
}

function watchHostMigration(gameId, roomId) {
  const key = `${gameId}/${roomId}`;
  if (hostWatchers.has(key)) return;
  const r = ref(db, `game_rooms/${gameId}/${roomId}/players`);
  const handler = onValue(r, () => electHost(gameId, roomId).catch(() => {}));
  hostWatchers.set(key, () => off(r, "value", handler));
}

async function electHost(gameId, roomId) {
  const roomPath = `game_rooms/${gameId}/${roomId}`;
  const [metaSnap, playersSnap] = await Promise.all([
    get(ref(db, `${roomPath}/meta`)),
    get(ref(db, `${roomPath}/players`))
  ]);
  const meta = metaSnap.val() || {};
  const players = playersSnap.val() || {};
  if (meta.hostUid && players[meta.hostUid]) return;
  const next = Object.entries(players).sort((a, b) => (a[1].slot || 0) - (b[1].slot || 0))[0];
  if (next) await update(ref(db, `${roomPath}/meta`), { hostUid: next[0], touchedAt: Date.now() });
}

async function purgeOldEvents(gameId, roomId) {
  const snap = await get(ref(db, `game_rooms/${gameId}/${roomId}/events`));
  const cutoff = Date.now() - 30000;
  const removals = [];
  snap.forEach((c) => {
    if ((c.val()?.ts || 0) < cutoff) removals.push(remove(ref(db, `game_rooms/${gameId}/${roomId}/events/${c.key}`)));
  });
  await Promise.all(removals);
}

async function purgeIdleRooms(gameId) {
  const snap = await get(ref(db, `game_rooms/${gameId}`));
  const cutoff = Date.now() - 10 * 60 * 1000;
  const removals = [];
  snap.forEach((c) => {
    const v = c.val();
    if ((v?.meta?.touchedAt || v?.meta?.createdAt || 0) < cutoff && !Object.keys(v?.players || {}).length) {
      removals.push(remove(ref(db, `game_rooms/${gameId}/${c.key}`)));
    }
  });
  await Promise.all(removals);
}

function safeId(value) {
  return String(value || "game").toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 60) || "game";
}

function safeRoom(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function safePath(value) {
  return String(value || "").split("/").filter(Boolean).map((part) => part.replace(/[.#$\[\]]/g, "_")).join("/");
}

function makeRoomId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function assignPath(target, path, value) {
  const parts = path.split("/").filter(Boolean);
  let cursor = target;
  while (parts.length > 1) {
    const part = parts.shift();
    cursor[part] = cursor[part] && typeof cursor[part] === "object" ? cursor[part] : {};
    cursor = cursor[part];
  }
  cursor[parts[0] || "value"] = value;
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function byteSize(value) {
  const text = JSON.stringify(value ?? null);
  if (typeof Blob !== "undefined") return new Blob([text]).size;
  return new TextEncoder().encode(text).length;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
