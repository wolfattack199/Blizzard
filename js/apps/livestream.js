// Livestream broadcaster — OBS-style layout. Captures camera / mic / screen,
// streams to viewers over WebRTC via Firebase signaling, and shows a real-time
// chat panel synced with viewers.

import {
  createStream, endStream, rtdbSet, rtdbPush, rtdbOn,
  subscribeStreamChat, sendStreamChat, setStreamViewers, setStreamThumbnail,
  registerStreamOnDisconnect, killAllMyLiveStreams,
  publishTubeFile
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";
import { avatarHtml } from "../os/avatar.js";
import * as FS from "../fs.js";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" }
];

export async function mountLivestream(root, ctx) {
  root.innerHTML = `
    <div class="app obs">
      <div class="obs-titlebar">
        <span style="font-weight:600;letter-spacing:0.5px">🔴 Livestream</span>
        <span class="grow"></span>
        <button data-act="kill-old" title="End any of my old streams left running" style="padding:3px 9px;font-size:11px">End all my old streams</button>
        <span class="muted" data-bind="status" style="font-size:12px;margin-left:10px">Idle</span>
      </div>
      <div class="obs-preview" data-bind="preview-pane">
        <video data-bind="preview" autoplay muted playsinline></video>
        <div class="obs-preview-empty" data-bind="preview-empty">No source. Pick one below, then click Go Live.</div>
        <div class="obs-chat-overlay" data-bind="chat-overlay"></div>
      </div>
      <div class="obs-panels">
        <div class="obs-panel">
          <div class="obs-panel-head">Sources</div>
          <div class="obs-panel-body">
            <label class="obs-src"><input type="checkbox" data-bind="src-cam">📷 Camera</label>
            <label class="obs-src"><input type="checkbox" data-bind="src-mic" checked>🎤 Microphone</label>
            <label class="obs-src"><input type="checkbox" data-bind="src-screen" checked>🖥 Screen share</label>
            <div class="obs-source-note">Only this Blizzard tab is allowed. Full screen and window capture are rejected before going live.</div>
          </div>
        </div>
        <div class="obs-panel">
          <div class="obs-panel-head">Audio Mixer</div>
          <div class="obs-panel-body">
            <div class="obs-mixer-row">
              <span style="width:60px">Mic</span>
              <div class="obs-meter" data-bind="mic-meter"><div class="obs-meter-bar" data-bind="mic-bar"></div></div>
            </div>
            <div class="obs-mixer-row">
              <span style="width:60px">Volume</span>
              <input type="range" min="0" max="1" step="0.05" value="1" data-bind="mic-gain" style="flex:1">
            </div>
          </div>
        </div>
        <div class="obs-panel">
          <div class="obs-panel-head">Stream Info</div>
          <div class="obs-panel-body">
            <input type="text" data-bind="title" placeholder="Stream title (visible on blizz://stream.blz)"
              style="width:100%;padding:7px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none">
            <div class="muted" style="font-size:11px;margin-top:6px" data-bind="viewers">0 watching</div>
          </div>
        </div>
        <div class="obs-panel">
          <div class="obs-panel-head">Controls</div>
          <div class="obs-panel-body">
            <button class="primary" data-act="go" style="width:100%;padding:8px;font-weight:600">🔴 Go live</button>
            <button class="danger" data-act="stop" style="width:100%;padding:8px;margin-top:6px;font-weight:600" disabled>Stop</button>
            <label class="obs-src" style="margin-top:8px"><input type="checkbox" data-bind="record">⏺ Record while live</label>
            <div class="muted" style="font-size:11px" data-bind="rec-status"></div>
          </div>
        </div>
        <div class="obs-panel obs-chat-panel">
          <div class="obs-panel-head">Chat</div>
          <div class="obs-chat" data-bind="chat"><div class="muted" style="padding:10px;font-size:12px">Chat appears here once you go live.</div></div>
          <div class="obs-chat-input">
            <input type="text" placeholder="Talk to viewers…" data-bind="chat-input" disabled>
            <button data-act="chat-send" disabled>Send</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const preview      = root.querySelector('[data-bind="preview"]');
  const previewEmpty = root.querySelector('[data-bind="preview-empty"]');
  const camCb     = root.querySelector('[data-bind="src-cam"]');
  const micCb     = root.querySelector('[data-bind="src-mic"]');
  const screenCb  = root.querySelector('[data-bind="src-screen"]');
  screenCb.closest(".obs-src").lastChild.textContent = " Blizzard OS tab";
  const titleIn   = root.querySelector('[data-bind="title"]');
  const goBtn     = root.querySelector('[data-act="go"]');
  const stopBtn   = root.querySelector('[data-act="stop"]');
  const status    = root.querySelector('[data-bind="status"]');
  const viewersEl = root.querySelector('[data-bind="viewers"]');
  const micBar    = root.querySelector('[data-bind="mic-bar"]');
  const micGain   = root.querySelector('[data-bind="mic-gain"]');
  const chatEl    = root.querySelector('[data-bind="chat"]');
  const chatIn    = root.querySelector('[data-bind="chat-input"]');
  const chatSend  = root.querySelector('[data-act="chat-send"]');

  let activeMedia = null;
  let activeStreamId = null;
  let peerConnections = new Map(); // viewerKey -> { pc, pendingIce: [], remoteSet: bool }
  let unsubs = [];
  let audioCtx = null, analyser = null, meterRaf = null, gainNode = null;
  let thumbTimer = null;
  let mediaRecorder = null;
  let recChunks = [];
  let recStartTs = 0;
  const recCb = root.querySelector('[data-bind="record"]');
  const recStatus = root.querySelector('[data-bind="rec-status"]');

  // Live preview — also show even before going live so user can verify their sources.
  async function refreshSources() {
    if (activeMedia) { activeMedia.getTracks().forEach((t) => t.stop()); }
    activeMedia = null;
    preview.srcObject = null;
    previewEmpty.style.display = "block";
    if (!camCb.checked && !micCb.checked && !screenCb.checked) return;
    try {
      let media;
      if (screenCb.checked) {
        media = await captureBlizzardTab();
        if (micCb.checked) {
          try {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            mic.getAudioTracks().forEach((t) => media.addTrack(t));
          } catch {}
        }
      } else if (camCb.checked || micCb.checked) {
        media = await navigator.mediaDevices.getUserMedia({
          video: camCb.checked, audio: micCb.checked
        });
      } else return;
      activeMedia = media;
      preview.srcObject = media;
      previewEmpty.style.display = "none";
      setupMeter(media);
    } catch (e) {
      alert("Could not capture: " + e.message);
      camCb.checked = false; micCb.checked = false; screenCb.checked = false;
    }
  }
  camCb.addEventListener("change", refreshSources);
  micCb.addEventListener("change", refreshSources);
  screenCb.addEventListener("change", refreshSources);

  function setupMeter(media) {
    if (audioCtx) { try { audioCtx.close(); } catch {} ; audioCtx = null; }
    if (meterRaf) cancelAnimationFrame(meterRaf);
    const audioTracks = media.getAudioTracks();
    if (audioTracks.length === 0) { micBar.style.width = "0%"; return; }
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    gainNode = audioCtx.createGain();
    gainNode.gain.value = parseFloat(micGain.value);
    src.connect(gainNode).connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    function tick() {
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      const avg = sum / buf.length;
      micBar.style.width = Math.min(100, avg * 1.2) + "%";
      meterRaf = requestAnimationFrame(tick);
    }
    tick();
  }
  micGain.addEventListener("input", () => {
    if (gainNode) gainNode.gain.value = parseFloat(micGain.value);
  });

  goBtn.onclick = async () => {
    if (!activeMedia) await refreshSources();
    if (!activeMedia) { alert("Pick a source first."); return; }
    const title = titleIn.value.trim() || `${ctx.user.username}'s stream`;

    activeStreamId = await createStream(ctx.user.uid, ctx.user.username, title);
    // Auto-shutdown if this tab disconnects without clicking Stop.
    registerStreamOnDisconnect(activeStreamId);
    status.textContent = "🔴 Live as blizz://stream.blz → @" + ctx.user.username;
    goBtn.disabled = true;
    stopBtn.disabled = false;
    chatIn.disabled = false;
    chatSend.disabled = false;
    chatEl.innerHTML = "";

    // Real-time chat
    const unsubChat = subscribeStreamChat(activeStreamId, appendChatMsg);
    unsubs.push(unsubChat);

    // Periodic thumbnail capture for the stream grid (Twitch-style previews)
    if (thumbTimer) clearInterval(thumbTimer);
    const tcanvas = document.createElement("canvas");
    tcanvas.width = 320; tcanvas.height = 180;
    const tcx = tcanvas.getContext("2d");
    const snapThumb = () => {
      if (!preview.videoWidth) return;
      try {
        tcx.drawImage(preview, 0, 0, tcanvas.width, tcanvas.height);
        const dataUrl = tcanvas.toDataURL("image/jpeg", 0.5);
        if (activeStreamId) setStreamThumbnail(activeStreamId, dataUrl).catch(() => {});
      } catch {}
    };
    setTimeout(snapThumb, 1500);
    thumbTimer = setInterval(snapThumb, 12000);

    // Optional recording: capture the broadcaster's media to a local file.
    if (recCb.checked && activeMedia) {
      try {
        const mime = pickMime();
        mediaRecorder = new MediaRecorder(activeMedia, mime ? { mimeType: mime } : undefined);
        recChunks = [];
        recStartTs = Date.now();
        mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
        mediaRecorder.start(1000);
        recStatus.textContent = "● Recording…";
      } catch (e) {
        recStatus.textContent = "Recording failed: " + e.message;
        mediaRecorder = null;
      }
    }

    // WebRTC: a new peer connection per viewer
    unsubs.push(rtdbOn(`streams/${activeStreamId}/offers`, "child_added", async ({ key }) => {
      if (peerConnections.has(key)) return;
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const entry = { pc, pendingIce: [], remoteSet: false };
      peerConnections.set(key, entry);
      updateViewerCount();

      activeMedia.getTracks().forEach((t) => pc.addTrack(t, activeMedia));

      pc.onicecandidate = (ev) => {
        if (ev.candidate) rtdbPush(`streams/${activeStreamId}/ice/host/${key}`, ev.candidate.toJSON());
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          peerConnections.delete(key);
          updateViewerCount();
        }
      };

      const unsubAns = rtdbOn(`streams/${activeStreamId}/offers/${key}/answer`, "value", async (ans) => {
        if (!ans) return;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(ans));
          entry.remoteSet = true;
          // Flush any queued ICE
          for (const c of entry.pendingIce) {
            try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
          }
          entry.pendingIce.length = 0;
        } catch {}
      });
      const unsubIce = rtdbOn(`streams/${activeStreamId}/ice/viewer/${key}`, "child_added", ({ val }) => {
        if (!entry.remoteSet) { entry.pendingIce.push(val); return; }
        pc.addIceCandidate(new RTCIceCandidate(val)).catch(() => {});
      });
      unsubs.push(unsubAns, unsubIce);

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await rtdbSet(`streams/${activeStreamId}/offers/${key}/offer`, offer.toJSON());
      } catch (e) {
        console.warn("Offer creation failed:", e);
      }
    }));
  };

  stopBtn.onclick = async () => {
    for (const { pc } of peerConnections.values()) { try { pc.close(); } catch {} }
    peerConnections.clear();
    updateViewerCount();
    if (thumbTimer) { clearInterval(thumbTimer); thumbTimer = null; }
    if (activeStreamId) await endStream(activeStreamId);
    activeStreamId = null;
    unsubs.forEach((u) => { try { u(); } catch {} });
    unsubs = [];
    goBtn.disabled = false;
    stopBtn.disabled = true;
    chatIn.disabled = true;
    chatSend.disabled = true;
    status.textContent = "Idle";
    await finalizeRecording();
  };

  function pickMime() {
    const cands = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
    for (const c of cands) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    }
    return "";
  }

  async function finalizeRecording() {
    if (!mediaRecorder) return;
    const recorder = mediaRecorder;
    mediaRecorder = null;
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      try { recorder.stop(); } catch { resolve(); }
    });
    if (recChunks.length === 0) { recStatus.textContent = "Recording empty."; return; }
    const blob = new Blob(recChunks, { type: recChunks[0]?.type || "video/webm" });
    recChunks = [];
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const stamp = new Date(recStartTs).toLocaleString().replace(/[\/:,\s]+/g, "-");
    const filename = `Recording ${stamp}.${ext}`;
    recStatus.textContent = "Saving recording…";
    try {
      const file = new File([blob], filename, { type: blob.type });
      await FS.uploadFile("/Cloud/My Files/Recordings", file);
      recStatus.textContent = `Saved /Cloud/My Files/Recordings/${filename}`;
      if (confirm(`Recording saved to /Cloud/My Files/Recordings/${filename}.\n\nPublish it to BlizzTube now?`)) {
        const title = prompt("Video title?", titleIn.value || filename);
        if (!title) return;
        const description = prompt("Description (optional):") || "";
        const tagStr = prompt("Tags (comma-separated, optional):") || "";
        const tags = tagStr
          ? tagStr.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).slice(0, 10)
          : [];
        try {
          await publishTubeFile(ctx.user.uid, ctx.user.username, file, { title, description, tags });
          alert("Published to BlizzTube — open blizz://blizztube.blz to see it.");
        } catch (e) {
          alert("Publish failed (file may exceed 6 MB): " + e.message);
        }
      }
    } catch (e) {
      recStatus.textContent = "Save failed: " + e.message;
    }
  }

  function updateViewerCount() {
    const n = peerConnections.size;
    viewersEl.textContent = n + " watching";
    if (activeStreamId) setStreamViewers(activeStreamId, n).catch(() => {});
  }

  // Chat
  const chatOverlay = root.querySelector('[data-bind="chat-overlay"]');
  function appendChatMsg(m) {
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

    // Mirror the message as a transient overlay on the preview so the
    // streamer can see chat without alt-tabbing.
    if (!isMine) {
      const ovl = document.createElement("div");
      ovl.className = "ovl-msg";
      ovl.innerHTML = `<span class="ovl-user">${escapeHtml(m.username || "?")}</span><span>${escapeHtml(m.text || "")}</span>`;
      chatOverlay.appendChild(ovl);
      // Keep only the last 6 visible.
      while (chatOverlay.children.length > 6) chatOverlay.firstElementChild.remove();
      setTimeout(() => { ovl.style.opacity = "0"; ovl.style.transition = "opacity 0.8s"; }, 9000);
      setTimeout(() => { ovl.remove(); }, 10000);
    }
  }
  function send() {
    const t = chatIn.value.trim();
    if (!t || !activeStreamId) return;
    sendStreamChat(activeStreamId, ctx.user.uid, ctx.user.username, t);
    chatIn.value = "";
  }
  chatSend.onclick = send;
  chatIn.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });

  // Cleanup ghost streams from previous sessions (closed without Stop).
  killAllMyLiveStreams(ctx.user.uid).catch(() => {});

  root.querySelector('[data-act="kill-old"]').onclick = async () => {
    if (!confirm("End every stream you own that's still marked live?")) return;
    await killAllMyLiveStreams(ctx.user.uid);
    alert("All your old streams have been marked offline.");
  };

  // Do not prompt immediately on app open. Go Live will capture the selected
  // default source, and changing any source also refreshes the preview.

  return () => {
    // Window is closing — make sure we tear down the broadcast cleanly.
    if (meterRaf) cancelAnimationFrame(meterRaf);
    if (audioCtx) { try { audioCtx.close(); } catch {} }
    // End the live stream right away so other users stop seeing us as live.
    if (activeStreamId) endStream(activeStreamId).catch(() => {});
    if (mediaRecorder) { try { mediaRecorder.stop(); } catch {} }
    if (activeMedia) activeMedia.getTracks().forEach((t) => t.stop());
  };
}

async function captureBlizzardTab() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("Your browser does not support tab capture.");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      displaySurface: "browser",
      logicalSurface: true,
      cursor: "always"
    },
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    monitorTypeSurfaces: "exclude",
    surfaceSwitching: "exclude"
  });

  const videoTrack = stream.getVideoTracks()[0];
  const settings = videoTrack?.getSettings?.() || {};
  if (settings.displaySurface !== "browser") {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("Select the current Blizzard browser tab, not your screen or another window.");
  }

  return stream;
}
