// blizz://apis — documentation for the APIs available to Blizzard sites.
// Sites running in the browser iframe can call window.bz.* (postMessage-based).
// External browser APIs (getUserMedia, getDisplayMedia, WebRTC, AudioContext)
// are also documented here with copy-paste-able snippets.
import { escapeHtml } from "../os/wm.js";

export async function renderApisPage(host, ctx, navigate, route) {
  host.innerHTML = `
    <div class="browser-home" style="text-align:left;max-width:900px;margin:0 auto;user-select:text;padding-bottom:60px">
      <div style="text-align:center">
        <div class="browser-home-title" style="font-size:42px">API Reference</div>
        <div class="browser-home-sub">Build apps, games, and clones of Discord / Twitch / etc. using these APIs.</div>
      </div>

      <h2 style="margin-top:32px;color:var(--accent-2)">🌐 Site APIs (window.bz)</h2>
      <p>Any site published on Blizzard (e.g. <code>blizz://mysite.com</code>) has a <code>window.bz</code> global. It's the OS-provided "backend": a per-site key/value store, message bus, and identity helper. No server code needed.</p>
      ${apiCard("Auth — who's visiting", "auth", `
const me = await bz.auth.whoami();
console.log(me.username, me.uid);  // e.g. "alex", "kF8…"`)}
      ${apiCard("Store data (single value)", "data", `
await bz.data.set("counter", 42);
const n = await bz.data.get("counter");`)}
      ${apiCard("Lists / collections", "data-list", `
const id = await bz.data.push("messages", { text: "hello", user: (await bz.auth.whoami()).username });
const all = await bz.data.list("messages");`)}
      ${apiCard("Live updates (real-time)", "data-sub", `
const unsub = bz.data.subscribe("messages", (latest) => {
  console.log("new state:", latest);
});
// later: unsub();`)}

      <h2 style="margin-top:32px;color:var(--accent-2)">🎤 Voice & Audio</h2>
      ${apiCard("Microphone access", "voice", `
const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
const audio = new Audio();
audio.srcObject = stream;
audio.play();`)}
      ${apiCard("Audio analyser (volume meter)", "audio-meter", `
const ctx = new AudioContext();
const src = ctx.createMediaStreamSource(stream);
const analyser = ctx.createAnalyser();
src.connect(analyser);
const buf = new Uint8Array(analyser.frequencyBinCount);
function tick() {
  analyser.getByteFrequencyData(buf);
  const v = buf.reduce((s, x) => s + x, 0) / buf.length;
  document.getElementById("level").style.width = v + "%";
  requestAnimationFrame(tick);
}
tick();`)}

      <h2 style="margin-top:32px;color:var(--accent-2)">📷 Camera & Video</h2>
      ${apiCard("Camera", "camera", `
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
document.querySelector("video").srcObject = stream;`)}
      ${apiCard("Screen share", "screen", `
const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
document.querySelector("video").srcObject = stream;`)}

      <h2 style="margin-top:32px;color:var(--accent-2)">🔗 Peer-to-peer (WebRTC)</h2>
      <p>For real-time voice/video, build a Discord/Twitch clone with WebRTC. Use <code>bz.data</code> as the signaling channel — write the SDP offer/answer + ICE candidates there, and the other peer subscribes to them.</p>
      ${apiCard("Caller side", "rtc-caller", `
const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
pc.onicecandidate = (e) => {
  if (e.candidate) bz.data.push("ice/caller", e.candidate.toJSON());
};
const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
local.getTracks().forEach((t) => pc.addTrack(t, local));
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
await bz.data.set("offer", offer.toJSON());

bz.data.subscribe("answer", async (a) => {
  if (a) await pc.setRemoteDescription(new RTCSessionDescription(a));
});
bz.data.subscribe("ice/callee", (cands) => {
  if (!cands) return;
  Object.values(cands).forEach((c) => pc.addIceCandidate(new RTCIceCandidate(c)));
});`)}

      ${apiCard("Callee side", "rtc-callee", `
const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
pc.ontrack = (e) => { document.querySelector("video").srcObject = e.streams[0]; };
pc.onicecandidate = (e) => {
  if (e.candidate) bz.data.push("ice/callee", e.candidate.toJSON());
};
bz.data.subscribe("offer", async (offer) => {
  if (!offer) return;
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await bz.data.set("answer", answer.toJSON());
});
bz.data.subscribe("ice/caller", (cands) => {
  if (!cands) return;
  Object.values(cands).forEach((c) => pc.addIceCandidate(new RTCIceCandidate(c)));
});`)}

      <h2 style="margin-top:32px;color:var(--accent-2)">🛠 Scaffolding from the Terminal</h2>
      <p>The Blizzard Terminal can drop ready-to-use boilerplate into your project. From your project folder:</p>
      <pre style="background:#0a0e18;color:#c8d4eb;padding:12px;border-radius:6px;font-family:var(--mono);font-size:12px;overflow:auto">
$ server init                    # adds a <code>server.html</code> using bz.data
$ api install voice              # voice/mic boilerplate
$ api install video              # camera boilerplate
$ api install screen             # screen share boilerplate
$ api install rtc                # WebRTC peer-to-peer template
$ api install chat               # Discord-like chat that uses bz.data
$ api install stream             # Twitch-like broadcaster template
$ api list                       # list every available template</pre>

      <h2 style="margin-top:32px;color:var(--accent-2)">⚠ Important</h2>
      <ul style="line-height:1.7;color:var(--text-1)">
        <li>Sites run in a sandboxed iframe with <code>allow-scripts</code>; they get their own JS context.</li>
        <li>Mic/camera/screen prompts go to the host browser (Chrome, Edge, Firefox), not Blizzard — your visitors must approve them.</li>
        <li><code>bz.data</code> is scoped per-domain. Two sites can't read each other's data.</li>
        <li>Proxies are <b>not</b> available. All content must originate inside Blizzard or be peer-to-peer between users.</li>
      </ul>
    </div>
  `;

  host.querySelectorAll("[data-copy]").forEach((b) =>
    b.addEventListener("click", () => {
      const code = b.parentElement.querySelector("pre").innerText;
      navigator.clipboard?.writeText(code);
      b.textContent = "Copied ✓";
      setTimeout(() => { b.textContent = "Copy"; }, 1200);
    })
  );

  // Section navigation: blizz://apis.blz/voice (or /rtc, /video, etc.)
  const section = (route?.path || "").replace(/^\/+/, "").toLowerCase().trim();
  if (section) {
    requestAnimationFrame(() => {
      const target = host.querySelector(`[data-copy="${section}"]`);
      if (target) {
        const card = target.closest("div");
        card?.scrollIntoView({ behavior: "smooth", block: "start" });
        card?.animate?.([
          { boxShadow: "0 0 0 2px var(--accent)" },
          { boxShadow: "0 0 0 2px transparent" }
        ], { duration: 1500 });
      }
    });
  }
}

function apiCard(title, id, code) {
  return `
    <div style="background:var(--bg-2);border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="color:var(--text-0)">${escapeHtml(title)}</strong>
        <button data-copy="${id}" style="padding:3px 10px;font-size:11.5px">Copy</button>
      </div>
      <pre style="margin:0;background:#0a0e18;color:#c8d4eb;padding:10px;border-radius:5px;font-family:var(--mono);font-size:12px;overflow:auto;white-space:pre-wrap;word-wrap:break-word">${escapeHtml(code.trim())}</pre>
    </div>
  `;
}
