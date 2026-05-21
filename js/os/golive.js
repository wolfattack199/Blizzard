// Go-live notifications: pops a toast when a streamer the signed-in user
// follows starts streaming. Runs once per Blizzard session (started after
// the desktop boots) and tracks which streams have already been notified
// so we don't double-toast on subsequent /streams snapshots.
import {
  subscribeMyFollows, subscribeLiveStreams, loadUser
} from "../firebase.js";
import { showToast } from "./toasts.js";

let unsubFollows = null;
let unsubLive = null;
let followedSet = new Set();
let notifiedLiveIds = new Set();
let primed = false;  // first snapshot doesn't toast — only later transitions

export function startGoLiveNotifier(uid) {
  if (!uid) return;
  stopGoLiveNotifier();
  unsubFollows = subscribeMyFollows(uid, (map) => {
    followedSet = new Set(Object.keys(map || {}));
  });
  unsubLive = subscribeLiveStreams((list) => {
    const currentLiveIds = new Set();
    for (const s of list || []) {
      if (!s?.id || !s.live) continue;
      currentLiveIds.add(s.id);
      // Only toast for streamers we follow, and skip our own streams.
      if (!primed) continue;
      if (s.ownerUid === uid) continue;
      if (!followedSet.has(s.ownerUid)) continue;
      if (notifiedLiveIds.has(s.id)) continue;
      notifiedLiveIds.add(s.id);
      popGoLiveToast(s);
    }
    // Drop entries for streams that have ended so we re-notify if the
    // streamer comes back online later.
    for (const id of [...notifiedLiveIds]) {
      if (!currentLiveIds.has(id)) notifiedLiveIds.delete(id);
    }
    primed = true;
  });
}

export function stopGoLiveNotifier() {
  if (unsubFollows) unsubFollows();
  if (unsubLive)    unsubLive();
  unsubFollows = unsubLive = null;
  followedSet = new Set();
  notifiedLiveIds = new Set();
  primed = false;
}

async function popGoLiveToast(s) {
  let user = null;
  try { user = await loadUser(s.ownerUid); } catch {}
  showToast({
    title: `@${s.ownerUsername || "someone"} is live!`,
    body: s.title || "Streaming on Blizzard",
    context: "blizz://stream.blz",
    user: user ? { ...user, uid: s.ownerUid } : { uid: s.ownerUid, username: s.ownerUsername },
    duration: 12000,
    onClick: () => {
      // Open the Blizzard browser straight to the streamer's channel page.
      if (window.bzLaunchApp) {
        window.bzLaunchApp("browser", { initialQuery: `blizz://stream.blz/@${(s.ownerUsername || "").toLowerCase()}` });
      }
    }
  });
}
