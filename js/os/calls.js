// Voice calls — Firebase-signaled WebRTC, audio only, 1-on-1, used by
// GuildWire DMs. The UI mirrors Discord: caller sees a big centered card with
// a pulsing avatar while the callee's tab rings with a generated two-tone
// chime. After 90 seconds without an answer the call is auto-cancelled as a
// missed call. Every call is appended to per-user `call-logs/{uid}`.
import {
  createCall, subscribeIncomingCalls, dismissIncomingCall,
  subscribeCall, setCallStatus,
  setCallOffer, setCallAnswer, pushCallIce, subscribeCallIce,
  subscribeCallAnswer, subscribeCallOffer,
  loadUser, logCall
} from "../firebase.js";
import { showToast } from "./toasts.js";
import { avatarHtml } from "./avatar.js";
import { escapeHtml } from "./wm.js";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];
const TIMEOUT_MS = 90 * 1000;   // 1m30s before a missed call

let myUid = null;
let myUsername = null;
let unsubIncoming = null;
let activeCall = null;          // { callId, side, pc, stream, ..., startedAt, connectedAt }
let activeDialog = null;        // DOM node for the in-call dialog
let activeRing = null;          // DOM node for the incoming-call ring

// ---------------------------------------------------------------------------
// Public lifecycle
// ---------------------------------------------------------------------------
export function startCallListener(uid, username) {
  myUid = uid; myUsername = username;
  if (unsubIncoming) unsubIncoming();
  unsubIncoming = subscribeIncomingCalls(uid, (inv) => showIncomingRing(inv));
}

export function stopCallListener() {
  if (unsubIncoming) unsubIncoming();
  unsubIncoming = null;
  hangup({ reason: "leaving" });
  closeRing();
}

// ---------------------------------------------------------------------------
// Caller side
// ---------------------------------------------------------------------------
export async function placeCall(toUser /* { uid, username } */) {
  if (activeCall) { alert("You're already on a call."); return; }
  if (!toUser?.uid || toUser.uid === myUid) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert("Microphone access is required to place a call: " + e.message);
    return;
  }

  const callId = await createCall(myUid, myUsername, toUser.uid);
  activeCall = await wireCallPeer({
    callId, side: "caller", stream, peer: toUser,
    onConnected: () => { /* dialog will update on its own */ },
    onEnded: (reason) => finalizeCall(reason)
  });
  activeCall.startedAt = Date.now();

  // Auto-cancel after TIMEOUT_MS if the callee hasn't picked up.
  activeCall.timeoutTimer = setTimeout(() => {
    if (activeCall && !activeCall.connectedAt) {
      hangup({ reason: "no-answer" });
    }
  }, TIMEOUT_MS);

  const offer = await activeCall.pc.createOffer();
  await activeCall.pc.setLocalDescription(offer);
  await setCallOffer(callId, offer.toJSON());

  activeCall.unsubAnswer = subscribeCallAnswer(callId, async (ans) => {
    if (!ans || !activeCall || activeCall.pc.currentRemoteDescription) return;
    try {
      await activeCall.pc.setRemoteDescription(new RTCSessionDescription(ans));
      activeCall.connectedAt = Date.now();
      if (activeCall.timeoutTimer) { clearTimeout(activeCall.timeoutTimer); activeCall.timeoutTimer = null; }
      renderCallDialog();
    } catch {}
  });

  showCallDialog({ peer: toUser, mode: "outgoing" });
}

// ---------------------------------------------------------------------------
// Callee side — accept an incoming invite.
// ---------------------------------------------------------------------------
async function acceptIncoming(inv) {
  if (activeCall) { alert("You're already on a call."); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert("Microphone access is required to take this call: " + e.message);
    await setCallStatus(inv.callId, "declined").catch(() => {});
    await dismissIncomingCall(myUid, inv.callId).catch(() => {});
    return;
  }
  stopRingtone();
  closeRing();
  await dismissIncomingCall(myUid, inv.callId);

  const peer = { uid: inv.from, username: inv.fromUsername };
  activeCall = await wireCallPeer({
    callId: inv.callId, side: "callee", stream, peer,
    onConnected: () => { /* dialog auto-updates */ },
    onEnded: (reason) => finalizeCall(reason)
  });
  activeCall.startedAt = inv.ts || Date.now();
  activeCall.connectedAt = Date.now();

  activeCall.unsubOffer = subscribeCallOffer(inv.callId, async (offer) => {
    if (!offer || !activeCall) return;
    try {
      await activeCall.pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await activeCall.pc.createAnswer();
      await activeCall.pc.setLocalDescription(answer);
      await setCallAnswer(inv.callId, answer.toJSON());
      await setCallStatus(inv.callId, "active");
    } catch {}
  });

  showCallDialog({ peer, mode: "incoming-accepted" });
}

// ---------------------------------------------------------------------------
// Hangup — works from any side, any state.
// ---------------------------------------------------------------------------
export async function hangup({ reason = "user" } = {}) {
  if (!activeCall) { closeCallDialog(); return; }
  const call = activeCall;
  activeCall = null;

  if (call.timeoutTimer) clearTimeout(call.timeoutTimer);
  try { call.unsubIce?.(); } catch {}
  try { call.unsubCall?.(); } catch {}
  try { call.unsubAnswer?.(); } catch {}
  try { call.unsubOffer?.(); } catch {}
  try { call.stream?.getTracks?.().forEach((t) => t.stop()); } catch {}
  try { call.pc?.close(); } catch {}
  try { call.remoteAudio?.remove(); } catch {}

  // Mark the call ended in Firebase so the other side hangs up too.
  try {
    if (reason === "no-answer")      await setCallStatus(call.callId, "missed");
    else                              await setCallStatus(call.callId, "ended");
  } catch {}

  call.onEnded?.(reason);
  closeCallDialog();
}

// ---------------------------------------------------------------------------
// WebRTC plumbing shared between caller and callee.
// ---------------------------------------------------------------------------
async function wireCallPeer({ callId, side, stream, peer, onConnected, onEnded }) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  pc.onicecandidate = (e) => {
    if (e.candidate) pushCallIce(callId, side, e.candidate.toJSON()).catch(() => {});
  };

  const remoteAudio = document.createElement("audio");
  remoteAudio.autoplay = true;
  remoteAudio.style.display = "none";
  document.body.appendChild(remoteAudio);
  pc.ontrack = (e) => { remoteAudio.srcObject = e.streams[0]; };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected" && activeCall && !activeCall.connectedAt) {
      activeCall.connectedAt = Date.now();
      onConnected?.();
      renderCallDialog();
    }
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      hangup({ reason: pc.connectionState });
    }
  };

  const otherSide = side === "caller" ? "callee" : "caller";
  const unsubIce = subscribeCallIce(callId, otherSide, async (cand) => {
    if (!cand) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch {}
  });

  // React to the remote ending / cancelling / declining.
  const unsubCall = subscribeCall(callId, (c) => {
    if (!c || !activeCall) return;
    if (["ended", "declined", "missed"].includes(c.status)) {
      hangup({ reason: c.status === "declined" ? "declined-by-peer" : "ended-by-peer" });
    }
  });

  return { callId, side, pc, stream, peer, remoteAudio, unsubIce, unsubCall, onEnded };
}

// ---------------------------------------------------------------------------
// Logging — write to both participants' history.
// ---------------------------------------------------------------------------
async function finalizeCall(reason) {
  if (!myUid) return;
  // The closure captured for this completion has already had activeCall set to
  // null, so pull values from the call argument the dialog kept on `_lastCall`.
  const c = window.__bzLastCall || activeDialog?._call;
  if (!c) return;
  const status = reason === "no-answer" ? "missed"
              : reason === "declined-by-peer" ? "declined"
              : reason === "ended-by-peer" ? "ended"
              : reason === "user" ? "ended"
              : reason;
  const duration = c.connectedAt ? (Date.now() - c.connectedAt) : 0;
  const direction = c.side === "caller" ? "outgoing" : "incoming";
  const otherUid  = c.peer?.uid || "";
  const otherUsername = c.peer?.username || "";
  await logCall(myUid, {
    callId: c.callId, direction, status, duration,
    otherUid, otherUsername
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// UI: in-call / outgoing-ringing dialog
// ---------------------------------------------------------------------------
function showCallDialog({ peer, mode }) {
  closeCallDialog();
  const dlg = document.createElement("div");
  dlg.className = "call-overlay";
  dlg._call = activeCall;
  window.__bzLastCall = activeCall;
  document.body.appendChild(dlg);
  activeDialog = dlg;
  renderCallDialog(mode);
}

function renderCallDialog(initialMode) {
  if (!activeDialog || !activeCall) return;
  const mode = initialMode || (activeCall.connectedAt ? "in-call" : (activeCall.side === "caller" ? "outgoing" : "in-call"));
  const peer = activeCall.peer || {};
  const av = avatarHtml(peer);
  const subtitle = mode === "outgoing"
    ? "Ringing…"
    : mode === "in-call" && activeCall.connectedAt
      ? "On call · " + formatDuration(Date.now() - activeCall.connectedAt)
      : "Connecting…";

  activeDialog.innerHTML = `
    <div class="call-card-big">
      <div class="call-avatar-big" style="${av.style}">${escapeHtml(av.text)}</div>
      <div class="call-name-big">@${escapeHtml(peer.username || "user")}</div>
      <div class="call-sub-big" data-bind="sub">${escapeHtml(subtitle)}</div>
      <div class="call-controls-big">
        <button data-act="mute" title="Mute mic">🎤</button>
        <button class="danger" data-act="end" title="End call">📞</button>
      </div>
    </div>
  `;

  let muted = false;
  activeDialog.querySelector('[data-act="mute"]').onclick = (e) => {
    if (!activeCall) return;
    muted = !muted;
    activeCall.stream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    e.currentTarget.classList.toggle("muted", muted);
    e.currentTarget.textContent = muted ? "🚫" : "🎤";
  };
  activeDialog.querySelector('[data-act="end"]').onclick = () => hangup({ reason: "user" });

  // Live-tick the duration / status text.
  if (activeDialog._tick) clearInterval(activeDialog._tick);
  activeDialog._tick = setInterval(() => {
    if (!activeCall || !activeDialog) return;
    const sub = activeDialog.querySelector('[data-bind="sub"]');
    if (!sub) return;
    if (activeCall.connectedAt) {
      sub.textContent = "On call · " + formatDuration(Date.now() - activeCall.connectedAt);
    } else if (activeCall.side === "caller") {
      const ring = Math.floor((Date.now() - (activeCall.startedAt || Date.now())) / 1000);
      const left = Math.max(0, Math.floor((TIMEOUT_MS - (Date.now() - (activeCall.startedAt || Date.now()))) / 1000));
      sub.textContent = `Ringing… ${ring}s (auto-cancel in ${left}s)`;
    }
  }, 500);
}

function closeCallDialog() {
  if (activeDialog?._tick) clearInterval(activeDialog._tick);
  activeDialog?.remove();
  activeDialog = null;
}

// ---------------------------------------------------------------------------
// UI: incoming ringer
// ---------------------------------------------------------------------------
function showIncomingRing(inv) {
  if (activeRing) closeRing();
  // Also drop the invite if the call was already cancelled remotely.
  loadUser(inv.from).then((u) => {
    const peer = { uid: inv.from, username: inv.fromUsername };
    const av = avatarHtml(u || peer);
    const ring = document.createElement("div");
    ring.id = "call-incoming-" + inv.callId;
    ring.className = "call-ringer";
    ring.innerHTML = `
      <div class="call-ringer-card">
        <div class="call-avatar-big ringing" style="${av.style}">${escapeHtml(av.text)}</div>
        <div class="call-name-big">@${escapeHtml(inv.fromUsername || "user")}</div>
        <div class="call-sub-big">Incoming voice call</div>
        <div class="call-controls-big">
          <button class="danger" data-act="decline" title="Decline">📞</button>
          <button class="accept" data-act="accept" title="Accept">✓</button>
        </div>
      </div>
    `;
    document.body.appendChild(ring);
    activeRing = ring;

    // Start a two-tone ringtone loop until the user reacts or it times out.
    startRingtone();

    const timeout = setTimeout(async () => {
      // Missed call — log it on both sides.
      await dismissIncomingCall(myUid, inv.callId).catch(() => {});
      await setCallStatus(inv.callId, "missed").catch(() => {});
      await logCall(myUid, {
        callId: inv.callId, direction: "incoming", status: "missed", duration: 0,
        otherUid: inv.from, otherUsername: inv.fromUsername
      }).catch(() => {});
      showToast({
        title: "Missed call",
        body: "@" + (inv.fromUsername || "someone") + " tried to call you.",
        duration: 8000,
        user: peer
      });
      closeRing();
    }, TIMEOUT_MS);

    // If the caller cancels before the callee reacts, kill the ringer immediately.
    const unsubCall = subscribeCall(inv.callId, (c) => {
      if (!c) { closeRing(); clearTimeout(timeout); try { unsubCall(); } catch {} return; }
      if (["ended", "cancelled", "missed", "declined"].includes(c.status)) {
        closeRing();
        clearTimeout(timeout);
        try { unsubCall(); } catch {}
      }
    });
    ring._cleanup = () => { clearTimeout(timeout); try { unsubCall(); } catch {} };

    ring.querySelector('[data-act="decline"]').onclick = async () => {
      await dismissIncomingCall(myUid, inv.callId).catch(() => {});
      await setCallStatus(inv.callId, "declined").catch(() => {});
      await logCall(myUid, {
        callId: inv.callId, direction: "incoming", status: "declined", duration: 0,
        otherUid: inv.from, otherUsername: inv.fromUsername
      }).catch(() => {});
      closeRing();
    };
    ring.querySelector('[data-act="accept"]').onclick = async () => { closeRing(); await acceptIncoming(inv); };

    // Toast as well, in case the user is on a different desktop / window.
    showToast({
      title: "📞 Incoming call",
      body: `From @${inv.fromUsername || "someone"}`,
      duration: 10000,
      user: peer,
      onClick: () => activeRing?.scrollIntoView()
    });
  });
}

function closeRing() {
  stopRingtone();
  if (!activeRing) return;
  activeRing._cleanup?.();
  activeRing.remove();
  activeRing = null;
}

// ---------------------------------------------------------------------------
// Web-audio ringtone. Two short blips per ring, 4-second cadence.
// ---------------------------------------------------------------------------
let ringCtx = null;
let ringTimer = null;
function startRingtone() {
  stopRingtone();
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ringCtx = new Ctx();
    const playBlip = (when, freq) => {
      const osc  = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(0.18, when + 0.02);
      gain.gain.linearRampToValueAtTime(0,    when + 0.5);
      osc.connect(gain).connect(ringCtx.destination);
      osc.start(when);
      osc.stop(when + 0.55);
    };
    const ringOnce = () => {
      const t = ringCtx.currentTime;
      playBlip(t,        880);
      playBlip(t + 0.6,  660);
    };
    ringOnce();
    ringTimer = setInterval(ringOnce, 4000);
  } catch {}
}
function stopRingtone() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
  if (ringCtx) { try { ringCtx.close(); } catch {} ringCtx = null; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

window.bzPlaceCall = placeCall;
