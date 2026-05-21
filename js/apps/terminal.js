// Terminal — simulated shell with built-in commands (ls, cd, cat, write, mkdir, rm,
// clone, publish, sites, whoami, help).
//
// Note on "clone": uses the public GitHub REST + raw.githubusercontent.com APIs,
// which both support CORS. This is NOT a proxy — content is fetched directly
// from GitHub and stored in the user's local virtual FS.

import * as FS from "../fs.js";
import { publishSite, getSite, listSites } from "../firebase.js";

export async function mountTerminal(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="terminal">
        <div class="terminal-output" data-bind="out"></div>
        <div class="terminal-input-line">
          <span class="terminal-prompt" data-bind="prompt"></span>
          <input class="terminal-input" data-bind="in" autocapitalize="off" autocomplete="off" spellcheck="false" />
        </div>
      </div>
    </div>
  `;

  const out = root.querySelector('[data-bind="out"]');
  const inp = root.querySelector('[data-bind="in"]');
  const prom = root.querySelector('[data-bind="prompt"]');

  let cwd = "/";
  const history = [];
  let hIdx = -1;

  function setPrompt() {
    prom.textContent = `${ctx.user.username}@blizzard:${cwd}$`;
  }

  function print(text, cls = "") {
    const line = document.createElement("div");
    line.className = "terminal-line" + (cls ? " " + cls : "");
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
    root.querySelector(".terminal").scrollTop = root.querySelector(".terminal").scrollHeight;
  }

  function ok(t) { print(t, "ok"); }
  function err(t) { print(t, "err"); }
  function dim(t) { print(t, "dim"); }
  function warn(t) { print(t, "warn"); }

  function abs(path) {
    if (!path) return cwd;
    if (path.startsWith("/")) return FS.normalize(path);
    if (path === "~") return "/";
    if (path === "..") {
      const parts = cwd.split("/").filter(Boolean);
      parts.pop();
      return "/" + parts.join("/");
    }
    return FS.normalize(cwd === "/" ? "/" + path : cwd + "/" + path);
  }

  // Banner
  print("Blizzard OS Terminal — type 'help' for commands.", "dim");
  print("");

  setPrompt();
  inp.focus();
  root.querySelector(".terminal").addEventListener("click", () => inp.focus());

  inp.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const line = inp.value;
      print(`${prom.textContent} ${line}`);
      inp.value = "";
      if (line.trim()) {
        history.push(line);
        hIdx = history.length;
        await run(line.trim());
      }
      setPrompt();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length === 0) return;
      hIdx = Math.max(0, hIdx - 1);
      inp.value = history[hIdx] || "";
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      hIdx = Math.min(history.length, hIdx + 1);
      inp.value = history[hIdx] || "";
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      out.innerHTML = "";
    }
  });

  async function run(line) {
    const parts = tokenize(line);
    const cmd = parts[0];
    const args = parts.slice(1);
    const handler = COMMANDS[cmd];
    if (!handler) {
      err(`blizzard: command not found: ${cmd}`);
      return;
    }
    try {
      await handler(args, { print, ok, err, dim, warn, abs, getCwd: () => cwd, setCwd: (p) => { cwd = p; }, ctx });
    } catch (e) {
      err(String(e?.message || e));
    }
  }
}

function tokenize(line) {
  const out = [];
  let cur = "", q = null;
  for (const c of line) {
    if (q) {
      if (c === q) { q = null; }
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === " " || c === "\t") {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const COMMANDS = {
  help: async (_, { print, dim }) => {
    print("Available commands:");
    dim("  help                          show this help");
    dim("  whoami                        print your username");
    dim("  pwd                           print working directory");
    dim("  ls [path]                     list files");
    dim("  cd <path>                     change directory");
    dim("  cat <file>                    print file contents");
    dim("  write <file> <text...>        write a file");
    dim("  mkdir <path>                  create folder");
    dim("  rm <path>                     remove file or folder");
    dim("  mv <from> <to>                rename / move");
    dim("  clone <owner/repo>[@branch] <dest>");
    dim("                                pull a GitHub repo into your FS");
    dim("  sites                         list published Blizzard domains");
    dim("  publish <domain.tld> [project]");
    dim("                                publish a project as blizz://<domain.tld>");
    dim("  clear                         clear the screen");
    dim("  echo <text...>                print text");
    dim("  open <app>                    open an app window");
    dim("  bundle [src] [out.blz]        package a folder into a single .blz archive");
    dim("  unbundle <file.blz> [dest]    extract a .blz back into its original files");
    dim("  server init                   add server.html (live data) to project");
    dim("  api list                      list API starter templates");
    dim("  api install <name>            add an API starter (voice|video|screen|rtc|chat|stream)");
  },
  whoami: async (_, { print, ctx }) => print(ctx.user.username),
  // Owner-only secret: opens the Admin Console. Hidden from `help`. To anyone
  // else, this looks like an unknown command — they can't even tell it exists.
  ghiy: async (_, { ok, err, ctx }) => {
    if ((ctx.user.username || "").toLowerCase() !== "wolfattack199") {
      err("blizzard: command not found: ghiy");
      return;
    }
    ctx.launchApp("admin");
    ok("Opening Admin Console...");
  },
  pwd: async (_, { print, getCwd }) => print(getCwd()),
  echo: async (args, { print }) => print(args.join(" ")),
  clear: async () => { document.querySelector(".terminal-output").innerHTML = ""; },
  ls: async (args, { print, dim, abs, err }) => {
    const path = abs(args[0] || ".");
    const items = await FS.list(path);
    if (items.length === 0) { dim("(empty)"); return; }
    items.forEach((it) => print(`  ${it.isDir ? "📁" : "📄"} ${it.name}${it.isDir ? "/" : ""}`));
  },
  cd: async (args, { abs, err, setCwd, getCwd }) => {
    if (!args[0]) { setCwd("/"); return; }
    const target = abs(args[0]);
    if (target === "/") { setCwd("/"); return; }
    const list = await FS.list(target);
    // If list returns anything OR target equals a known parent path, accept it.
    // (We can't easily detect "is folder" — try listing parent for the name.)
    const parent = target.split("/").slice(0, -1).join("/") || "/";
    const name = target.split("/").pop();
    const items = await FS.list(parent);
    const match = items.find((i) => i.name === name && i.isDir);
    if (!match && list.length === 0) {
      // Maybe it is a file, not a folder.
      const rec = await FS.read(target);
      if (rec) { err(`cd: not a directory: ${target}`); return; }
      err(`cd: no such file or directory: ${target}`);
      return;
    }
    setCwd(target);
  },
  cat: async (args, { print, err, abs }) => {
    if (!args[0]) { err("cat: missing file"); return; }
    const rec = await FS.read(abs(args[0]));
    if (!rec) { err(`cat: ${args[0]}: no such file`); return; }
    print(rec.content || "");
  },
  write: async (args, { err, abs, ok }) => {
    if (args.length < 1) { err("write: usage: write <file> [text...]"); return; }
    const file = abs(args[0]);
    const text = args.slice(1).join(" ");
    await FS.write(file, text);
    ok(`Wrote ${file}`);
  },
  mkdir: async (args, { err, ok, abs }) => {
    if (!args[0]) { err("mkdir: missing path"); return; }
    await FS.mkdir(abs(args[0]));
    ok(`Created ${abs(args[0])}`);
  },
  rm: async (args, { err, ok, abs }) => {
    if (!args[0]) { err("rm: missing path"); return; }
    await FS.remove(abs(args[0]));
    ok(`Removed ${abs(args[0])}`);
  },
  mv: async (args, { err, ok, abs }) => {
    if (args.length < 2) { err("mv: usage: mv <from> <to>"); return; }
    await FS.rename(abs(args[0]), abs(args[1]));
    ok(`Moved ${abs(args[0])} → ${abs(args[1])}`);
  },
  sites: async (_, { print, dim }) => {
    const all = await listSites();
    if (all.length === 0) { dim("No sites have been published yet."); return; }
    all.forEach((s) => print(`  blizz://${s.domain}  —  ${s.description || ""}`));
  },
  publish: async (args, { ok, err, print, dim, warn, abs, ctx }) => {
    if (!args[0]) { err("publish: usage: publish <domain> [project-path]"); return; }
    const domain = args[0].toLowerCase();
    if (!/^[a-z0-9_-]{2,30}\.[a-z]{2,10}$/.test(domain)) {
      err("publish: invalid domain. Format: name.tld (e.g. mysite.com, cool.blz)");
      return;
    }
    // Default project folder is just the domain name without TLD.
    const defaultProj = "/Projects/" + domain.split(".")[0];
    const projPath = args[1] ? abs(args[1]) : abs(defaultProj);
    if (!await FS.exists(projPath) && (await FS.list(projPath)).length === 0) {
      err(`publish: project not found: ${projPath}`);
      return;
    }
    // Ownership check
    const existing = await getSite(domain);
    if (existing && existing.owner !== ctx.user.uid && !(existing.collaborators && existing.collaborators[ctx.user.uid])) {
      err(`publish: domain "${domain}" is owned by another user.`);
      return;
    }
    const files = (await FS.list(projPath, { recursive: true })).filter((f) => !f.isDir && f.name !== ".keep");
    if (files.length === 0) { err("publish: project is empty"); return; }
    const map = {};
    for (const f of files) {
      const rec = await FS.read(f.path);
      map[f.path.slice(projPath.length + 1)] = rec?.content || "";
    }
    if (!map["index.html"]) warn("publish: no index.html found — visitors will see an empty site.");

    print(`Publishing ${files.length} file(s) to blizz://${domain} …`);
    await publishSite(domain, ctx.user.uid, map, existing?.description || "");
    await FS.write(projPath + "/.blizzard-domain", domain);
    ok(`Published. Open the Blizzard browser and visit blizz://${domain}`);
  },
  open: async (args, { err, ctx }) => {
    if (!args[0]) { err("open: usage: open <app-id>"); return; }
    ctx.launchApp(args[0]);
  },
  bundle: async (args, { ok, err, dim, print, abs, getCwd }) => {
    // bundle [project-folder] [output.blz]
    // Defaults to current dir → /Downloads/<name>.blz
    const src = args[0] ? abs(args[0]) : getCwd();
    if (src === "/") { err("bundle: refuse to bundle root."); return; }
    const files = (await FS.list(src, { recursive: true })).filter((f) => !f.isDir && f.name !== ".keep");
    if (files.length === 0) { err(`bundle: no files in ${src}`); return; }
    const fileMap = {};
    for (const f of files) {
      const rec = await FS.read(f.path);
      fileMap[f.path.slice(src.length + 1)] = rec?.content || "";
    }
    const name = src.split("/").pop();
    const outPath = args[1] ? abs(args[1]) : `/Downloads/${name}.blz`;
    const payload = JSON.stringify({
      _blz: 1,
      name,
      createdAt: Date.now(),
      files: fileMap
    }, null, 2);
    await FS.write(outPath, payload);
    ok(`Bundled ${files.length} file(s) → ${outPath}`);
    dim(`Right-click it in File Explorer → "Unbundle to project…" to restore.`);
  },
  unbundle: async (args, { ok, err, dim, print, abs }) => {
    if (!args[0]) { err("unbundle: usage: unbundle <file.blz> [/Projects/<dest>]"); return; }
    const src = abs(args[0]);
    const rec = await FS.read(src);
    if (!rec) { err(`unbundle: not found: ${src}`); return; }
    let raw = rec.content || "";
    if (typeof raw === "string" && raw.startsWith("data:")) {
      try {
        const comma = raw.indexOf(",");
        const meta = raw.slice(0, comma);
        const data = raw.slice(comma + 1);
        raw = meta.includes(";base64") ? decodeURIComponent(escape(atob(data))) : decodeURIComponent(data);
      } catch {}
    }
    const base = (src.split("/").pop() || "bundle").replace(/\.blz$/i, "");
    const dest = args[1] ? abs(args[1]) : `/Projects/${base}`;
    const trimmed = raw.trimStart();
    if (trimmed.startsWith("{") && trimmed.includes('"_blz"')) {
      const obj = JSON.parse(trimmed);
      for (const [rel, content] of Object.entries(obj.files || {})) {
        const safeRel = rel.replace(/^\/+/, "").replace(/\.\./g, "");
        await FS.write(dest + "/" + safeRel, typeof content === "string" ? content : JSON.stringify(content, null, 2));
      }
      ok(`Unbundled ${Object.keys(obj.files || {}).length} file(s) into ${dest}`);
      return;
    }
    // Legacy HTML
    await FS.write(dest + "/index.html", raw);
    ok(`Unbundled HTML file into ${dest}/index.html`);
    dim(`(For a richer split into style.css / app.js, use File Explorer → right-click → Unbundle.)`);
  },
  server: async (args, { ok, err, dim, print, getCwd }) => {
    const sub = args[0];
    if (!sub || sub === "init") {
      const target = getCwd();
      if (target === "/" || target.split("/").length < 3) {
        err("server: run this inside a project folder, e.g. /Projects/mysite");
        return;
      }
      const html = SERVER_TEMPLATE;
      await FS.write(target + "/server.html", html);
      ok(`Wrote ${target}/server.html`);
      dim("Open it in Blizzard Studios, then 'publish' your project. Visitors of");
      dim("your site (in the Blizzard browser) get window.bz.* for live data.");
      return;
    }
    err("server: unknown subcommand. Try: server init");
  },
  api: async (args, { ok, err, dim, print, getCwd }) => {
    const sub = args[0];
    const templates = {
      voice: API_VOICE, video: API_VIDEO, screen: API_SCREEN,
      rtc: API_RTC, chat: API_CHAT, stream: API_STREAM
    };
    if (sub === "list") {
      print("Available API templates:");
      Object.keys(templates).forEach((n) => dim("  " + n));
      return;
    }
    if (sub === "install") {
      const name = args[1];
      if (!name || !templates[name]) {
        err("api install: usage: api install <" + Object.keys(templates).join("|") + ">");
        return;
      }
      const target = getCwd();
      if (target === "/" || target.split("/").length < 3) {
        err("api install: run inside a project folder, e.g. /Projects/mysite");
        return;
      }
      const file = target + "/" + name + ".html";
      await FS.write(file, templates[name]);
      ok(`Wrote ${file}`);
      dim(`Open it in Studios — it's a working starter for the "${name}" API.`);
      return;
    }
    err("api: unknown subcommand. Try: api list  |  api install voice");
  },
  clone: async (args, { ok, err, dim, warn, print, abs }) => {
    if (args.length < 2) {
      err("clone: usage: clone <owner/repo>[@branch] <destination>");
      dim("        example: clone microsoft/vscode-docs@main /Projects/vscode-docs");
      return;
    }
    let [spec, dest] = args;
    let branch = "main";
    if (spec.includes("@")) [spec, branch] = spec.split("@");
    if (!/^[\w.-]+\/[\w.-]+$/.test(spec)) {
      err("clone: invalid repo spec. Expected owner/repo.");
      return;
    }
    const destPath = abs(dest);
    print(`Cloning ${spec}@${branch} → ${destPath}`);

    // First try the requested branch; if 404, fall back to master.
    let tree = await fetchTree(spec, branch);
    if (!tree && branch === "main") {
      branch = "master";
      print("  (main not found, trying master)");
      tree = await fetchTree(spec, branch);
    }
    if (!tree) { err("clone: could not fetch repo tree (repo may not exist or be private)."); return; }

    if (tree.truncated) {
      warn("  warning: tree was truncated — large repo, some files may be missing.");
    }
    let count = 0;
    for (const node of tree.tree) {
      if (node.type !== "blob") continue;
      const url = `https://raw.githubusercontent.com/${spec}/${branch}/${node.path}`;
      try {
        const txt = await (await fetch(url)).text();
        await FS.write(destPath + "/" + node.path, txt);
        count++;
        if (count % 10 === 0) print(`  …${count} files`);
      } catch (e) {
        dim(`  skip ${node.path} (${e.message})`);
      }
    }
    ok(`Cloned ${count} file(s) into ${destPath}.`);
  },
};

async function fetchTree(spec, branch) {
  const url = `https://api.github.com/repos/${spec}/git/trees/${branch}?recursive=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

// ============================================================================
// API starter templates dropped into projects by `api install <name>`.
// Each is a self-contained HTML page demonstrating one capability.
// ============================================================================
const SERVER_TEMPLATE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Live data demo</title></head>
<body style="font-family:system-ui;padding:20px;background:#0b1220;color:#eaf2ff">
  <h1>Live data</h1>
  <p>Visitors of this site share a real-time counter.</p>
  <div style="font-size:48px;font-weight:200" id="n">…</div>
  <button onclick="bump()" style="padding:8px 16px;font-size:16px">Bump +1</button>
  <script>
    async function start() {
      bz.data.subscribe("counter", (v) => document.getElementById("n").textContent = v || 0);
    }
    async function bump() {
      const cur = (await bz.data.get("counter")) || 0;
      await bz.data.set("counter", cur + 1);
    }
    start();
  <\/script>
</body></html>`;

const API_VOICE = `<!doctype html><html><body style="font-family:system-ui;padding:20px">
<h2>Mic test</h2>
<button onclick="start()">Allow mic</button>
<div id="level" style="height:20px;background:#5aa9ff;width:0%;margin-top:14px;transition:width 0.1s"></div>
<script>
async function start() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ac = new AudioContext();
  const src = ac.createMediaStreamSource(stream);
  const an = ac.createAnalyser();
  src.connect(an);
  const buf = new Uint8Array(an.frequencyBinCount);
  function tick() {
    an.getByteFrequencyData(buf);
    const v = buf.reduce((s, x) => s + x, 0) / buf.length;
    document.getElementById("level").style.width = Math.min(100, v) + "%";
    requestAnimationFrame(tick);
  }
  tick();
}
<\/script></body></html>`;

const API_VIDEO = `<!doctype html><html><body style="margin:0;background:#000">
<video id="v" autoplay playsinline style="width:100vw;height:100vh;object-fit:contain"></video>
<script>
navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  .then(s => { document.getElementById("v").srcObject = s; })
  .catch(e => document.body.innerHTML = "Camera denied: " + e.message);
<\/script></body></html>`;

const API_SCREEN = `<!doctype html><html><body style="margin:0;background:#000;color:#fff;font-family:system-ui">
<button onclick="go()" style="position:fixed;top:10px;left:10px;z-index:1;padding:8px 14px">Share screen</button>
<video id="v" autoplay playsinline style="width:100vw;height:100vh;object-fit:contain"></video>
<script>
async function go() {
  const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  document.getElementById("v").srcObject = s;
}
<\/script></body></html>`;

const API_RTC = `<!doctype html><html><body style="font-family:system-ui;padding:20px;background:#0b1220;color:#eaf2ff">
<h2>WebRTC peer-to-peer</h2>
<p>Open this site in two browser windows (signed in as different users) to test.</p>
<button onclick="callerStart()">Be the caller</button>
<button onclick="calleeStart()">Be the callee</button>
<video id="v" autoplay playsinline style="width:100%;background:#000;margin-top:14px"></video>
<script>
const ICE = [{ urls: "stun:stun.l.google.com:19302" }];
async function callerStart() {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  pc.onicecandidate = (e) => e.candidate && bz.data.push("ice/caller", e.candidate.toJSON());
  const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  s.getTracks().forEach(t => pc.addTrack(t, s));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await bz.data.set("offer", offer.toJSON());
  bz.data.subscribe("answer", async a => a && pc.setRemoteDescription(new RTCSessionDescription(a)));
  bz.data.subscribe("ice/callee", c => c && Object.values(c).forEach(x => pc.addIceCandidate(new RTCIceCandidate(x))));
}
async function calleeStart() {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  pc.ontrack = (e) => { document.getElementById("v").srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => e.candidate && bz.data.push("ice/callee", e.candidate.toJSON());
  bz.data.subscribe("offer", async o => {
    if (!o) return;
    await pc.setRemoteDescription(new RTCSessionDescription(o));
    const a = await pc.createAnswer();
    await pc.setLocalDescription(a);
    await bz.data.set("answer", a.toJSON());
  });
  bz.data.subscribe("ice/caller", c => c && Object.values(c).forEach(x => pc.addIceCandidate(new RTCIceCandidate(x))));
}
<\/script></body></html>`;

const API_CHAT = `<!doctype html><html><body style="font-family:system-ui;padding:14px;background:#0b1220;color:#eaf2ff;height:100vh;box-sizing:border-box;margin:0;display:flex;flex-direction:column">
<h2 style="margin:0 0 10px">Live chat</h2>
<div id="log" style="flex:1;overflow-y:auto;background:rgba(0,0,0,0.3);padding:10px;border-radius:6px"></div>
<form id="f" style="display:flex;gap:6px;margin-top:10px"><input id="i" style="flex:1;padding:8px;background:#19243d;border:1px solid #243352;border-radius:5px;color:#fff;outline:none" placeholder="Say something…"><button>Send</button></form>
<script>
async function start() {
  const me = await bz.auth.whoami();
  bz.data.subscribe("messages", (all) => {
    document.getElementById("log").innerHTML = Object.values(all || {})
      .sort((a,b) => a.ts - b.ts)
      .map(m => "<div><b>@" + m.user + ":</b> " + m.text + "</div>").join("");
    document.getElementById("log").scrollTop = 1e9;
  });
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const text = document.getElementById("i").value.trim();
    if (!text) return;
    await bz.data.push("messages", { text, user: me.username, ts: Date.now() });
    document.getElementById("i").value = "";
  };
}
start();
<\/script></body></html>`;

const API_STREAM = `<!doctype html><html><body style="font-family:system-ui;padding:14px;background:#0b1220;color:#eaf2ff">
<h2>Streamer demo</h2>
<p>This is a starter — your site, your rules. See blizz://apis.blz for the full peer-to-peer recipe.</p>
<button onclick="capture()">Start cam+mic</button>
<video id="v" autoplay playsinline muted style="width:100%;background:#000;margin-top:10px"></video>
<script>
async function capture() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  document.getElementById("v").srcObject = s;
  await bz.data.set("live", { startedAt: Date.now() });
}
<\/script></body></html>`;
