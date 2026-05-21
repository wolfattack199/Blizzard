import { db, ref, get, set, update, runTransaction } from "./firebase.js";

// Message-count achievements removed deliberately: rewarding raw send volume
// encourages spam-floods that lag the channels for everyone else.
export const EARLY_BIRD_CUTOFF_MS = Date.UTC(2026, 5, 6, 0, 0, 0); // 2026-06-06 00:00 UTC

export const ACHIEVEMENT_CATALOG = {
  first_message: {
    id: "first_message", name: "First Words", description: "Send your first message",
    glyph: "\u{1F4AC}", tier: "bronze", points: 10,
    trigger: { type: "counter", key: "messages_sent", threshold: 1 }
  },
  first_dm: {
    id: "first_dm", name: "Whisper", description: "Send your first DM",
    glyph: "\u{1F5E8}", tier: "bronze", points: 10,
    trigger: { type: "counter", key: "dms_sent", threshold: 1 }
  },
  first_server_join: {
    id: "first_server_join", name: "Joining the Flock", description: "Join your first server",
    glyph: "\u{1F465}", tier: "bronze", points: 10,
    trigger: { type: "counter", key: "servers_joined", threshold: 1 }
  },
  server_owner: {
    id: "server_owner", name: "Founder", description: "Create your first server",
    glyph: "\u{1F3F0}", tier: "silver", points: 25,
    trigger: { type: "counter", key: "servers_created", threshold: 1 }
  },
  first_tube: {
    id: "first_tube", name: "Hit Record", description: "Publish your first BlizzTube video",
    glyph: "\u{1F3A5}", tier: "silver", points: 25,
    trigger: { type: "counter", key: "tubes_published", threshold: 1 }
  },
  tube_10: {
    id: "tube_10", name: "Showrunner", description: "Publish 10 videos",
    glyph: "\u{1F3AC}", tier: "gold", points: 75,
    trigger: { type: "counter", key: "tubes_published", threshold: 10 }
  },
  first_tune: {
    id: "first_tune", name: "Drop the Beat", description: "Upload your first Tune",
    glyph: "\u{1F3B5}", tier: "silver", points: 25,
    trigger: { type: "counter", key: "tunes_uploaded", threshold: 1 }
  },
  first_stream: {
    id: "first_stream", name: "Going Live", description: "Stream for the first time",
    glyph: "\u{1F534}", tier: "silver", points: 25,
    trigger: { type: "counter", key: "streams_started", threshold: 1 }
  },
  stream_1hr: {
    id: "stream_1hr", name: "Hour One", description: "Stream for 60 total minutes",
    glyph: "\u{23F1}", tier: "gold", points: 75,
    trigger: { type: "counter", key: "stream_minutes", threshold: 60 }
  },
  first_site: {
    id: "first_site", name: "Webmaster", description: "Publish your first site",
    glyph: "\u{1F310}", tier: "silver", points: 25,
    trigger: { type: "counter", key: "sites_published", threshold: 1 }
  },
  first_game: {
    id: "first_game", name: "Game Maker", description: "Publish a game from the Engine",
    glyph: "\u{1F3AE}", tier: "gold", points: 50,
    trigger: { type: "counter", key: "games_published", threshold: 1 }
  },
  first_extension: {
    id: "first_extension", name: "Tinkerer", description: "Publish a browser extension",
    glyph: "\u{1F9E9}", tier: "gold", points: 50,
    trigger: { type: "counter", key: "extensions_published", threshold: 1 }
  },
  cloud_filer: {
    id: "cloud_filer", name: "Pack Rat", description: "Upload 50 files to Cloud",
    glyph: "\u{2601}", tier: "bronze", points: 15,
    trigger: { type: "counter", key: "cloud_files_uploaded", threshold: 50 }
  },
  night_owl: {
    id: "night_owl", name: "Night Owl", description: "Be online between 2-5 AM",
    glyph: "\u{1F319}", tier: "bronze", points: 10,
    trigger: { type: "direct" }
  },
  early_bird: {
    id: "early_bird", name: "Early Bird",
    description: "Be online between 5-7 AM before June 6, 2026 (limited-time)",
    glyph: "\u{1F305}", tier: "bronze", points: 10,
    trigger: { type: "direct" },
    cutoffMs: EARLY_BIRD_CUTOFF_MS
  },
  friend_5: {
    id: "friend_5", name: "Squad Goals", description: "Have 5 friends",
    glyph: "\u{1F91D}", tier: "bronze", points: 15,
    trigger: { type: "counter", key: "friends_count", threshold: 5 }
  },
  first_report: {
    id: "first_report", name: "Good Samaritan", description: "File your first report",
    glyph: "\u{2691}", tier: "bronze", points: 10,
    trigger: { type: "counter", key: "reports_filed", threshold: 1 }
  },
  mod_appointed: {
    id: "mod_appointed", name: "Trusted", description: "Get promoted to moderator",
    glyph: "\u{1F6E1}", tier: "gold", points: 100,
    trigger: { type: "direct" }
  },
  customizer: {
    id: "customizer", name: "Stylist", description: "Change your wallpaper or accent color",
    glyph: "\u{1F3A8}", tier: "bronze", points: 5,
    trigger: { type: "direct" }
  },
  playlist_maker: {
    id: "playlist_maker", name: "DJ", description: "Create your first playlist",
    glyph: "\u{1F3A7}", tier: "bronze", points: 10,
    trigger: { type: "counter", key: "playlists_created", threshold: 1 }
  },
  polyglot: {
    id: "polyglot", name: "Polyglot", description: "Publish a site using all 5 custom languages",
    glyph: "\u{1F5FA}", tier: "platinum", points: 200,
    trigger: { type: "direct" }
  },
  og_user: {
    id: "og_user", name: "Founding Member", description: "Created account in the first 30 days of Blizzard's existence",
    glyph: "\u{2744}", tier: "platinum", points: 250,
    trigger: { type: "direct" }
  }
};

let currentUid = null;
let catalog = null;

export async function ensureAchievementsCatalog() {
  const snap = await get(ref(db, "achievements_catalog"));
  if (!snap.exists()) await set(ref(db, "achievements_catalog"), ACHIEVEMENT_CATALOG);
  catalog = normalizeCatalog(snap.exists() ? snap.val() : ACHIEVEMENT_CATALOG);
  return catalog;
}

export async function initAchievements(uid) {
  currentUid = uid;
  await loadCatalog();
  const hour = new Date().getHours();
  if (hour >= 2 && hour < 5) await unlockDirect("night_owl");
  // Early Bird is a limited-time badge — can only be earned before the cutoff.
  if (hour >= 5 && hour < 7 && Date.now() < EARLY_BIRD_CUTOFF_MS) await unlockDirect("early_bird");
}

export async function getAchievementsCatalog() {
  return loadCatalog();
}

export async function bumpCounter(key, amount = 1) {
  if (!currentUid) return null;
  return bumpCounterForUser(currentUid, key, amount);
}

export async function bumpCounterForUser(uid, key, amount = 1) {
  if (!uid || !key) return null;
  const counterRef = ref(db, `users/${uid}/counters/${key}`);
  const result = await runTransaction(counterRef, (cur) => (Number(cur) || 0) + amount);
  const currentValue = Number(result.snapshot.val()) || 0;
  await checkUnlocksFor(uid, key, currentValue);
  return currentValue;
}

export async function unlockDirect(id) {
  if (!currentUid) return false;
  return unlockDirectForUser(currentUid, id);
}

export async function unlockDirectForUser(uid, id) {
  const list = await loadCatalog();
  const achievement = list[id];
  if (!achievement) return false;
  return grantAchievement(uid, achievement);
}

async function loadCatalog() {
  if (catalog) return catalog;
  const snap = await get(ref(db, "achievements_catalog")).catch(() => null);
  catalog = normalizeCatalog(snap?.val() || ACHIEVEMENT_CATALOG);
  return catalog;
}

function normalizeCatalog(raw = {}) {
  return Object.fromEntries(Object.values(raw || {}).map((a) => [a.id, a]));
}

async function checkUnlocksFor(uid, counterKey, currentValue) {
  const list = await loadCatalog();
  const unlocked = (await get(ref(db, `users/${uid}/achievements`))).val() || {};
  for (const achievement of Object.values(list)) {
    if (achievement.trigger?.type !== "counter") continue;
    if (achievement.trigger.key !== counterKey) continue;
    if (unlocked[achievement.id]) continue;
    if (currentValue >= achievement.trigger.threshold) await grantAchievement(uid, achievement);
  }
}

async function grantAchievement(uid, achievement) {
  const rowRef = ref(db, `users/${uid}/achievements/${achievement.id}`);
  const stamp = Date.now();
  const result = await runTransaction(rowRef, (cur) => cur || { unlockedAt: stamp });
  if (!result.committed || result.snapshot.val()?.unlockedAt !== stamp) return false;
  await runTransaction(ref(db, `users/${uid}/points`), (cur) => (Number(cur) || 0) + (Number(achievement.points) || 0));
  if (uid === currentUid) {
    document.dispatchEvent(new CustomEvent("blizzard:achievement", { detail: achievement }));
  }
  return true;
}
