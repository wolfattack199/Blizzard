// Twitch-like — viewing live streams. The broadcaster side lives in
// js/apps/livestream.js. This module provides both:
//   - mountStream(root, ctx)          — standalone app
//   - renderTwitchHome(host, ctx)     — embedded in the Blizzard browser
import {
  subscribeLiveStreams, getStream, rtdbSet, rtdbPush, rtdbOn,
  endStream, subscribeStreamChat, sendStreamChat,
  loadUser, reportSite,
  followStreamer, unfollowStreamer, isFollowing
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";
import { avatarHtml } from "../os/avatar.js";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

export async function mountStream(root, ctx) {
  root.innerHTML = `<div class="app"></div>`;
  await renderTwitchHome(root.firstElementChild, ctx);
}

export async function renderTwitchHome(host, ctx) {
  // Auto-resume: if the user was previously watching a stream (e.g. they
  // refreshed the tab), jump straight back to that stream as long as it's
  // still live. Wipes the marker once consumed so manual Back works.
  const lastId = loadLastViewing(ctx?.user?.uid);
  if (lastId) {
    const s = await getStream(lastId).catch(() => null);
    if (s?.live) { return openViewer(lastId, host, ctx); }
    clearViewing(ctx?.user?.uid);
  }

  host.innerHTML = `
    <div class="twitch-home">
      <div class="twitch-topbar">
        <div class="twitch-brand">
          <span class="twitch-brand-mark">🔴</span>
          <span>Blizzard Streams</span>
        </div>
        <input type="search" class="twitch-search" placeholder="Search streams, streamers, categories…" data-bind="q">
        <button class="primary twitch-broadcast" data-act="broadcast">📺 Go Live</button>
      </div>
      <div class="twitch-body">
        <div class="twitch-sidebar">
          <div class="twitch-sidebar-head">FOLLOWED & LIVE</div>
          <div data-bind="sidebar"><div class="muted" style="padding:14px;font-size:12px">Loading…</div></div>
        </div>
        <div class="twitch-main">
          <div class="twitch-hero" data-bind="hero"></div>
          <div class="twitch-section-title">Live channels</div>
          <div class="twitch-grid" data-bind="grid">
            <div class="muted" style="padding:30px;text-align:center;grid-column:1/-1">Loading streams…</div>
          </div>
        </div>
      </div>
    </div>
  `;
  const grid = host.querySelector('[data-bind="grid"]');
  const sidebar = host.querySelector('[data-bind="sidebar"]');
  const hero = host.querySelector('[data-bind="hero"]');
  const search = host.querySelector('[data-bind="q"]');
  let allStreams = [];

  function thumbFor(s) {
    if (s.thumb && s.thumb.startsWith("data:")) {
      return `<img src="${escapeHtml(s.thumb)}" class="twitch-thumb-img" alt="">`;
    }
    return `<div class="twitch-thumb-fallback">📺</div>`;
  }

  function liveBadge() {
    return `<span class="twitch-live-pill"><span class="twitch-live-dot"></span>LIVE</span>`;
  }

  function render() {
    const q = (search.value || "").toLowerCase().trim();
    const filtered = q
      ? allStreams.filter((s) => (s.title || "").toLowerCase().includes(q) ||
                                  (s.ownerUsername || "").toLowerCase().includes(q))
      : allStreams;

    // Sidebar — top live by viewer count, excluding YOU.
    const top = [...allStreams]
      .filter((s) => s.ownerUid !== ctx.user.uid)
      .sort((a, b) => (b.viewers || 0) - (a.viewers || 0))
      .slice(0, 10);
    if (top.length === 0) {
      sidebar.innerHTML = `<div class="muted" style="padding:14px;font-size:12px;color:#adadb8">Nobody else is live right now.</div>`;
    } else {
      sidebar.innerHTML = top.map((s) => {
        const av = avatarHtml({ uid: s.ownerUid, username: s.ownerUsername });
        return `
          <div class="twitch-side-row" data-id="${escapeHtml(s.id)}">
            <div class="twitch-side-av" style="${av.style}">${escapeHtml(av.text)}</div>
            <div class="twitch-side-meta">
              <div class="twitch-side-name">${escapeHtml(s.ownerUsername || "anon")}</div>
              <div class="twitch-side-game">${escapeHtml((s.title || "").slice(0, 28))}</div>
            </div>
            <div class="twitch-side-viewers"><span class="twitch-live-dot"></span>${s.viewers || 0}</div>
          </div>
        `;
      }).join("");
      sidebar.querySelectorAll(".twitch-side-row").forEach((r) =>
        r.addEventListener("click", () => openViewer(r.dataset.id, host, ctx))
      );
    }

    // Hero — featured stream (most viewers)
    if (filtered.length === 0 && !q) {
      hero.innerHTML = `<div class="twitch-hero-empty">
        <div style="font-size:48px;opacity:0.5">📺</div>
        <div style="font-weight:500;margin-top:6px">No streams. Come back later.</div>
        <div style="font-size:13px;margin-top:4px;color:#adadb8">Or be the first — click "Go Live" up top.</div>
      </div>`;
    } else if (filtered.length > 0) {
      const featured = filtered[0];
      const av = avatarHtml({ uid: featured.ownerUid, username: featured.ownerUsername });
      hero.innerHTML = `
        <div class="twitch-hero-card" data-id="${escapeHtml(featured.id)}">
          <div class="twitch-hero-thumb">
            ${thumbFor(featured)}
            ${liveBadge()}
            <span class="twitch-hero-viewers"><span class="twitch-live-dot"></span>${featured.viewers || 0} viewers</span>
          </div>
          <div class="twitch-hero-info">
            <div class="twitch-hero-av" style="${av.style}">${escapeHtml(av.text)}</div>
            <div style="min-width:0">
              <div class="twitch-hero-title">${escapeHtml(featured.title || "Untitled stream")}</div>
              <div class="twitch-hero-channel">@${escapeHtml(featured.ownerUsername || "anon")}</div>
            </div>
            <span class="grow" style="flex:1"></span>
            <button class="primary" data-act="watch-hero">▶ Watch</button>
          </div>
        </div>
      `;
      hero.querySelector('[data-act="watch-hero"]').onclick = () => openViewer(featured.id, host, ctx);
      hero.querySelector(".twitch-hero-card").addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        openViewer(featured.id, host, ctx);
      });
    } else {
      hero.innerHTML = "";
    }

    // Grid
    const gridStreams = filtered.length > 0 ? filtered.slice(1) : [];
    if (gridStreams.length === 0) {
      grid.innerHTML = q
        ? `<div class="muted" style="padding:30px;text-align:center;grid-column:1/-1">No streams match "${escapeHtml(q)}".</div>`
        : "";
    } else {
      grid.innerHTML = gridStreams.map((s) => {
        const av = avatarHtml({ uid: s.ownerUid, username: s.ownerUsername });
        return `
          <div class="twitch-card" data-id="${escapeHtml(s.id)}">
            <div class="twitch-card-thumb">
              ${thumbFor(s)}
              ${liveBadge()}
              <span class="twitch-card-viewers"><span class="twitch-live-dot"></span>${s.viewers || 0}</span>
            </div>
            <div class="twitch-card-info">
              <div class="twitch-card-av" style="${av.style}">${escapeHtml(av.text)}</div>
              <div style="min-width:0;flex:1">
                <div class="twitch-card-title">${escapeHtml(s.title || "Untitled stream")}</div>
                <div class="twitch-card-channel">@${escapeHtml(s.ownerUsername || "anon")}</div>
              </div>
            </div>
          </div>
        `;
      }).join("");
      grid.querySelectorAll(".twitch-card").forEach((card) =>
        card.addEventListener("click", () => openViewer(card.dataset.id, host, ctx))
      );
    }
  }

  search.addEventListener("input", render);
  host.querySelector('[data-act="broadcast"]').onclick = () => {
    if (ctx.launchApp) ctx.launchApp("livestream");
  };

  const unsub = subscribeLiveStreams((streams) => {
    allStreams = streams;
    render();
  });

  if (host.__bzCleanup) host.__bzCleanup();
  host.__bzCleanup = unsub;

  // Expose hook for blizz://stream.blz/@username deep links.
  host.__bzOpenViewerByUsername = (username) => {
    const tryOpen = () => {
      const s = allStreams.find((x) => (x.ownerUsername || "").toLowerCase() === username);
      if (s) { openViewer(s.id, host, ctx); return true; }
      return false;
    };
    if (!tryOpen()) {
      // Give the subscription a beat to populate.
      setTimeout(() => {
        if (!tryOpen()) alert(`@${username} isn't streaming right now.`);
      }, 600);
    }
  };
}

// --------------------------------------------------------------------------
// Viewer: WebRTC peer to the broadcaster, signaled via Firebase.
// --------------------------------------------------------------------------
// Each browser tab "remembers" which stream the user was watching so a
// refresh restores them to the same channel instead of dumping them back to
// the lobby. Cleared on Back. Scoped per Blizzard user.
function viewerStorageKey(uid) { return `blizzard.stream.lastViewing.${uid || "guest"}`; }
function rememberViewingStream(uid, streamId) {
  try { localStorage.setItem(viewerStorageKey(uid), streamId || ""); } catch {}
}
function loadLastViewing(uid) {
  try { return localStorage.getItem(viewerStorageKey(uid)) || ""; } catch { return ""; }
}
function clearViewing(uid) {
  try { localStorage.removeItem(viewerStorageKey(uid)); } catch {}
}

async function openViewer(streamId, host, ctx) {
  const stream = await getStream(streamId);
  if (!stream) return;
  if (!stream.live) {
    // Don't strand the user on a dead stream after a reload — wipe + bail.
    clearViewing(ctx.user.uid);
    alert("This stream just ended.");
    renderTwitchHome(host, ctx);
    return;
  }
  rememberViewingStream(ctx.user.uid, streamId);

  host.innerHTML = `
    <div class="app" style="background:#000">
      <div class="app-toolbar" style="background:#000;border-bottom-color:#1f1f23">
        <button data-act="back" style="background:#1f1f23;border-color:#2f2f35;color:#fff">← Back</button>
        <span class="grow"></span>
        <button data-act="report" title="Report this stream" style="background:transparent;border:1px solid #2f2f35;padding:3px 10px;font-size:12px;color:#fff">⚑ Report</button>
        <span style="background:#ff3344;color:#fff;font-size:10px;padding:2px 6px;border-radius:3px;font-weight:700;letter-spacing:0.4px;margin-left:8px">LIVE</span>
      </div>
      <div class="stream-stage">
        <div class="stream-video-col">
          <video data-bind="v" autoplay playsinline controls></video>
          <div class="stream-info">
            <div style="display:flex;align-items:center;gap:10px">
              <div style="flex:1;min-width:0">
                <div style="font-weight:600;font-size:16px;color:#fff">${escapeHtml(stream.title || "Untitled stream")}</div>
                <div style="color:#adadb8;font-size:12.5px;margin-top:2px">by @${escapeHtml(stream.ownerUsername || "anon")}</div>
              </div>
              ${stream.ownerUid !== ctx.user.uid
                ? `<button data-act="follow" style="background:#9147ff;border-color:#9147ff;color:#fff;padding:6px 14px;font-weight:600">Follow</button>`
                : ""}
            </div>
            <div data-bind="status" style="color:#adadb8;font-size:11.5px;margin-top:6px">Connecting…</div>
          </div>
        </div>
        <div class="stream-chat-col">
          <div class="stream-chat-head">💬 Stream chat</div>
          <div class="stream-chat" data-bind="chat"><div class="muted" style="padding:14px;font-size:12px;color:#adadb8">Say hi to the streamer!</div></div>
          <div class="stream-chat-input">
            <input type="text" placeholder="Message the stream…" data-bind="ci">
            <button class="primary" data-act="csend" style="background:#9147ff;border-color:#9147ff;color:#fff">Send</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const v = host.querySelector('[data-bind="v"]');
  const status = host.querySelector('[data-bind="status"]');
  const chatEl = host.querySelector('[data-bind="chat"]');
  const ciEl = host.querySelector('[data-bind="ci"]');

  // Chat subscription
  let firstChatBatch = true;
  const unsubChat = subscribeStreamChat(streamId, (m) => {
    if (firstChatBatch && chatEl.children[0]?.classList?.contains("muted")) {
      chatEl.innerHTML = "";
      firstChatBatch = false;
    }
    const av = avatarHtml({ uid: m.uid, username: m.username });
    const isMine = m.uid === ctx.user.uid;
    const div = document.createElement("div");
    div.className = "obs-chat-msg" + (isMine ? " me" : "");
    div.innerHTML = `
      <div class="obs-chat-av" style="${av.style}">${escapeHtml(av.text)}</div>
      <div class="obs-chat-body">
        <span class="obs-chat-user">${escapeHtml(m.username || "?")}</span>
        <span class="obs-chat-text">${escapeHtml(m.text || "")}</span>
      </div>
    `;
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
  });

  function sendChat() {
    const t = ciEl.value.trim();
    if (!t) return;
    sendStreamChat(streamId, ctx.user.uid, ctx.user.username, t);
    ciEl.value = "";
  }
  host.querySelector('[data-act="csend"]').onclick = sendChat;
  ciEl.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

  // WebRTC peer (viewer side)
  const viewerKey = ctx.user.uid + "_" + Date.now().toString(36);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const pendingIce = [];
  let remoteSet = false;

  pc.ontrack = (ev) => {
    console.log("Stream track received", ev.track?.kind, streamId);
    v.srcObject = ev.streams[0];
    v.play?.().catch(() => {});
    status.textContent = "🟢 Watching live";
  };
  pc.onicecandidate = (ev) => {
    if (ev.candidate) rtdbPush(`streams/${streamId}/ice/viewer/${viewerKey}`, serializeIceCandidate(ev.candidate));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connecting") status.textContent = "Connecting…";
    if (pc.connectionState === "connected") status.textContent = "🟢 Watching live";
    if (pc.connectionState === "failed") status.textContent = "Connection failed. Try Back → re-open.";
  };

  // Receive offer from broadcaster
  const unsubOffer = rtdbOn(`streams/${streamId}/offers/${viewerKey}/offer`, "value", async (val) => {
    if (!val) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(normalizeSessionDescription(val)));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await rtdbSet(`streams/${streamId}/offers/${viewerKey}/answer`, serializeSessionDescription(pc.localDescription || answer));
      remoteSet = true;
      for (const c of pendingIce) {
        try { await pc.addIceCandidate(new RTCIceCandidate(normalizeIceCandidate(c))); } catch {}
      }
      pendingIce.length = 0;
    } catch (e) {
      status.textContent = "Connection failed: " + e.message;
    }
  });

  // Receive ICE from broadcaster — queue until remote SDP is set
  const unsubIce = rtdbOn(`streams/${streamId}/ice/host/${viewerKey}`, "child_added", ({ val }) => {
    if (!remoteSet) { pendingIce.push(val); return; }
    pc.addIceCandidate(new RTCIceCandidate(normalizeIceCandidate(val))).catch(() => {});
  });

  // Signal our presence
  await rtdbSet(`streams/${streamId}/offers/${viewerKey}/joinedAt`, Date.now());

  host.querySelector('[data-act="back"]').onclick = () => {
    try { unsubOffer(); } catch {}
    try { unsubIce(); } catch {}
    try { unsubChat(); } catch {}
    try { pc.close(); } catch {}
    clearViewing(ctx.user.uid);
    renderTwitchHome(host, ctx);
  };

  const followBtn = host.querySelector('[data-act="follow"]');
  if (followBtn) {
    const refreshFollowBtn = async () => {
      const f = await isFollowing(ctx.user.uid, stream.ownerUid).catch(() => false);
      followBtn.textContent = f ? "Following ✓" : "Follow";
      followBtn.style.background  = f ? "transparent" : "#9147ff";
      followBtn.style.borderColor = f ? "#9147ff"     : "#9147ff";
    };
    refreshFollowBtn();
    followBtn.onclick = async () => {
      const f = await isFollowing(ctx.user.uid, stream.ownerUid).catch(() => false);
      if (f) await unfollowStreamer(ctx.user.uid, stream.ownerUid);
      else   await followStreamer(ctx.user.uid, stream.ownerUid);
      refreshFollowBtn();
    };
  }

  host.querySelector('[data-act="report"]').onclick = async () => {
    const reason = prompt(`Report @${stream.ownerUsername}'s stream "${stream.title || "Untitled"}".\n\nWhy are you reporting it?`);
    if (!reason || !reason.trim()) return;
    try {
      // Stash on the same reports/ node used by site reports; prefix domain so
      // admins can tell it's a stream rather than a site.
      await reportSite(`stream:${streamId}`, ctx.user.uid, ctx.user.username, reason.trim());
      alert("Report submitted. Admins can review it at blizz://reports.blz");
    } catch (e) {
      alert("Report failed: " + e.message);
    }
  };
}

function serializeSessionDescription(desc) {
  if (!desc) return null;
  if (typeof desc.toJSON === "function") return desc.toJSON();
  return { type: desc.type, sdp: desc.sdp };
}

function serializeIceCandidate(candidate) {
  if (!candidate) return null;
  if (typeof candidate.toJSON === "function") return candidate.toJSON();
  const out = {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex
  };
  if (candidate.usernameFragment != null) out.usernameFragment = candidate.usernameFragment;
  return out;
}

function normalizeSessionDescription(desc) {
  return { type: desc?.type, sdp: desc?.sdp };
}

function normalizeIceCandidate(candidate) {
  return {
    candidate: candidate?.candidate,
    sdpMid: candidate?.sdpMid ?? null,
    sdpMLineIndex: candidate?.sdpMLineIndex ?? null,
    usernameFragment: candidate?.usernameFragment
  };
}
