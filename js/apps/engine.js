// Blizzard Engine — minimal 2D game maker.
// Drop sprites (emoji or image URLs) onto a stage, pick which one's the player,
// hit Run to play. Arrow keys move the player; touching a "goal" wins,
// touching a "hazard" resets. Publish exports an HTML game to the Community Hub.

import { publishGame } from "../firebase.js";
import { escapeHtml } from "../os/wm.js";

const ROLE_OPTIONS = [
  { id: "decor", label: "Decor (just visual)" },
  { id: "player", label: "Player (arrow keys)" },
  { id: "wall", label: "Wall (blocks player)" },
  { id: "goal", label: "Goal (touch to win)" },
  { id: "hazard", label: "Hazard (touch to reset)" }
];
const PALETTE = ["😀","🦊","🐱","🐶","⭐","💎","🔥","💀","🌳","🪨","🏠","🚪","🎯","🍎","🎈","⚡","❤️","💧"];

export async function mountEngine(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="app-toolbar">
        <button data-act="new">＋ New scene</button>
        <button data-act="run">▶ Run</button>
        <button data-act="edit" disabled>✎ Edit</button>
        <button class="primary" data-act="publish">⬆ Publish to Community Hub</button>
        <label class="muted" style="display:flex;align-items:center;gap:6px;font-size:12px">
          <input type="checkbox" data-bind="multiplayer"> Multiplayer
        </label>
        <span class="grow"></span>
        <span class="muted" data-bind="status" style="font-size:12px"></span>
      </div>
      <div style="display:flex;flex:1;min-height:0">
        <div style="width:200px;background:var(--bg-0);border-right:1px solid var(--line);padding:10px;display:flex;flex-direction:column;gap:6px;overflow-y:auto">
          <div class="muted" style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.6px;padding-bottom:6px">Sprites · drag to stage</div>
          <div data-bind="palette" style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px"></div>
          <div class="muted" style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.6px;padding:10px 0 6px">Custom image URL</div>
          <input type="text" data-bind="customImg" placeholder="https://…/sprite.png"
            style="padding:5px 8px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:4px;color:var(--text-0);outline:none;font-size:12px">
          <button data-act="addImg" style="font-size:11.5px">Add image sprite</button>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;min-width:0">
          <div data-bind="stage" tabindex="-1"
            style="flex:1;position:relative;background:#1a2238;overflow:hidden;outline:none;cursor:crosshair"></div>
          <div class="muted" style="padding:6px 10px;background:var(--bg-0);border-top:1px solid var(--line);font-size:11.5px">
            Drag sprites from the left onto the stage. Click a placed sprite to edit it.
          </div>
        </div>
        <div style="width:220px;background:var(--bg-0);border-left:1px solid var(--line);padding:10px;overflow-y:auto" data-bind="inspector">
          <div class="muted">Select a sprite to edit it.</div>
        </div>
      </div>
    </div>
  `;

  const stage      = root.querySelector('[data-bind="stage"]');
  const palette    = root.querySelector('[data-bind="palette"]');
  const customImg  = root.querySelector('[data-bind="customImg"]');
  const inspector  = root.querySelector('[data-bind="inspector"]');
  const status     = root.querySelector('[data-bind="status"]');
  const multiplayer = root.querySelector('[data-bind="multiplayer"]');

  let model = newScene();
  let selectedId = null;
  let mode = "edit"; // or "run"

  function newScene() { return { name: "Untitled Scene", bg: "#1a2238", multiplayer: false, sprites: [] }; }
  function uid() { return Math.random().toString(36).slice(2, 9); }

  palette.innerHTML = PALETTE.map((e) =>
    `<div class="builder-tool" draggable="true" data-emoji="${e}" style="text-align:center;font-size:22px;padding:6px">${e}</div>`
  ).join("");
  palette.querySelectorAll(".builder-tool").forEach((t) =>
    t.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/blizz-sprite", JSON.stringify({ kind: "emoji", value: t.dataset.emoji })))
  );
  root.querySelector('[data-act="addImg"]').onclick = () => {
    const url = customImg.value.trim();
    if (!url) return;
    const sprite = { id: uid(), kind: "image", value: url, x: 80, y: 80, size: 48, role: "decor" };
    model.sprites.push(sprite);
    selectedId = sprite.id;
    customImg.value = "";
    render();
  };
  multiplayer.onchange = () => { model.multiplayer = multiplayer.checked; };

  stage.addEventListener("dragover", (e) => e.preventDefault());
  stage.addEventListener("drop", (e) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData("text/blizz-sprite");
    if (!raw) return;
    const { kind, value } = JSON.parse(raw);
    const r = stage.getBoundingClientRect();
    const sprite = {
      id: uid(), kind, value,
      x: e.clientX - r.left - 24,
      y: e.clientY - r.top - 24,
      size: 48,
      role: "decor"
    };
    model.sprites.push(sprite);
    selectedId = sprite.id;
    render();
  });

  function render() {
    multiplayer.checked = !!model.multiplayer;
    stage.style.background = model.bg;
    stage.innerHTML = model.sprites.map((s) => `
      <div data-id="${s.id}"
        style="position:absolute;left:${s.x}px;top:${s.y}px;width:${s.size}px;height:${s.size}px;display:flex;align-items:center;justify-content:center;font-size:${s.size * 0.8}px;cursor:grab;user-select:none;line-height:1;${s.id === selectedId ? "outline:2px solid var(--accent)" : ""}${s.role === 'goal' ? ';filter: drop-shadow(0 0 8px gold)' : ''}${s.role === 'hazard' ? ';filter: drop-shadow(0 0 8px #ff3344)' : ''}${s.role === 'player' ? ';filter: drop-shadow(0 0 6px #5aa9ff)' : ''}">
        ${s.kind === "image" ? `<img src="${escapeHtml(s.value)}" alt="" style="width:100%;height:100%;object-fit:contain;pointer-events:none">` : escapeHtml(s.value)}
      </div>
    `).join("");

    stage.querySelectorAll("[data-id]").forEach((el) => {
      const id = el.dataset.id;
      el.addEventListener("mousedown", (ev) => {
        if (mode === "run") return;
        ev.stopPropagation();
        selectedId = id;
        render();
        const s = model.sprites.find((x) => x.id === id);
        const startX = ev.clientX, startY = ev.clientY;
        const sx = s.x, sy = s.y;
        let moved = false;
        function move(mev) {
          moved = true;
          s.x = sx + (mev.clientX - startX);
          s.y = sy + (mev.clientY - startY);
          el.style.left = s.x + "px";
          el.style.top  = s.y + "px";
        }
        function up() {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          if (moved) render();
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
    });

    renderInspector();
  }

  function renderInspector() {
    const s = model.sprites.find((x) => x.id === selectedId);
    if (!s) {
      inspector.innerHTML = `
        <div class="muted">Select a sprite to edit it.</div>
        <div style="margin-top:14px">
          <label class="muted" style="font-size:11px">Background</label>
          <input type="color" data-bind="bg" value="${model.bg}" style="width:100%;height:30px;border:1px solid var(--line);background:transparent;margin-top:4px">
        </div>
        <div style="margin-top:14px">
          <label class="muted" style="font-size:11px">Scene name</label>
          <input type="text" data-bind="name" value="${escapeHtml(model.name)}"
            style="width:100%;padding:5px 7px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:4px;color:var(--text-0);margin-top:4px;outline:none">
        </div>
      `;
      const bg = inspector.querySelector('[data-bind="bg"]');
      if (bg) bg.onchange = (e) => { model.bg = e.target.value; render(); };
      const name = inspector.querySelector('[data-bind="name"]');
      if (name) name.oninput = (e) => { model.name = e.target.value; };
      return;
    }
    inspector.innerHTML = `
      <div style="margin-bottom:10px;display:flex;align-items:center;gap:8px">
        <div style="width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:22px;background:var(--bg-2);border-radius:6px">${s.kind === "image" ? "🖼" : s.value}</div>
        <span class="muted">Sprite</span>
      </div>
      <label class="muted" style="font-size:11px">Role</label>
      <select data-bind="role" style="width:100%;padding:5px 7px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:4px;color:var(--text-0);margin-top:4px;outline:none">
        ${ROLE_OPTIONS.map((r) => `<option value="${r.id}"${s.role === r.id ? " selected" : ""}>${r.label}</option>`).join("")}
      </select>
      <label class="muted" style="font-size:11px;display:block;margin-top:10px">Size: <span data-bind="szlbl">${s.size}</span> px</label>
      <input type="range" min="16" max="200" step="4" value="${s.size}" data-bind="sz" style="width:100%">
      <div class="row" style="gap:4px;margin-top:14px">
        <button class="danger" data-act="del" style="flex:1">Delete</button>
      </div>
    `;
    inspector.querySelector('[data-bind="role"]').onchange = (e) => { s.role = e.target.value; render(); };
    const sz = inspector.querySelector('[data-bind="sz"]');
    const szLbl = inspector.querySelector('[data-bind="szlbl"]');
    sz.oninput = () => { s.size = parseInt(sz.value, 10); szLbl.textContent = s.size; render(); };
    inspector.querySelector('[data-act="del"]').onclick = () => {
      model.sprites = model.sprites.filter((x) => x.id !== s.id);
      selectedId = null;
      render();
    };
  }

  stage.addEventListener("click", (e) => {
    if (e.target === stage && mode === "edit") { selectedId = null; render(); }
  });

  // Run mode -----------------------------------------------------------------
  let runHandle = null;
  function startRun() {
    if (mode === "run") return;
    mode = "run";
    root.querySelector('[data-act="run"]').disabled = true;
    root.querySelector('[data-act="edit"]').disabled = false;
    stage.style.cursor = "default";
    status.textContent = "Playing — arrow keys";

    const player = model.sprites.find((s) => s.role === "player");
    if (!player) { alert("No player sprite. Set one sprite's role to 'Player'."); endRun(); return; }

    const startPos = { x: player.x, y: player.y };
    const keys = {};
    const onDown = (e) => { keys[e.key] = true; if (e.key.startsWith("Arrow")) e.preventDefault(); };
    const onUp   = (e) => { keys[e.key] = false; };
    stage.focus();
    stage.addEventListener("keydown", onDown);
    stage.addEventListener("keyup", onUp);

    function step() {
      const speed = 4;
      let dx = 0, dy = 0;
      if (keys.ArrowLeft)  dx -= speed;
      if (keys.ArrowRight) dx += speed;
      if (keys.ArrowUp)    dy -= speed;
      if (keys.ArrowDown)  dy += speed;
      const next = { x: player.x + dx, y: player.y + dy };

      // Wall collision: reject if overlapping any wall
      const walls = model.sprites.filter((s) => s.role === "wall");
      let blocked = false;
      for (const w of walls) {
        if (rectOverlap(next, player.size, w, w.size)) { blocked = true; break; }
      }
      if (!blocked) {
        player.x = next.x;
        player.y = next.y;
      }
      // Keep in stage
      const r = stage.getBoundingClientRect();
      player.x = Math.max(0, Math.min(r.width  - player.size, player.x));
      player.y = Math.max(0, Math.min(r.height - player.size, player.y));

      // Goal / hazard
      for (const o of model.sprites) {
        if (o === player) continue;
        if (rectOverlap(player, player.size, o, o.size)) {
          if (o.role === "goal")  { status.textContent = "🎉 You won!"; endRun(); return; }
          if (o.role === "hazard"){ player.x = startPos.x; player.y = startPos.y; }
        }
      }
      render();
      runHandle = requestAnimationFrame(step);
    }
    runHandle = requestAnimationFrame(step);

    root.__runCleanup = () => {
      stage.removeEventListener("keydown", onDown);
      stage.removeEventListener("keyup", onUp);
      if (runHandle) cancelAnimationFrame(runHandle);
      runHandle = null;
    };
  }
  function endRun() {
    mode = "edit";
    root.querySelector('[data-act="run"]').disabled = false;
    root.querySelector('[data-act="edit"]').disabled = true;
    stage.style.cursor = "crosshair";
    if (root.__runCleanup) { root.__runCleanup(); root.__runCleanup = null; }
    render();
  }
  function rectOverlap(a, aSize, b, bSize) {
    return a.x < b.x + bSize && a.x + aSize > b.x && a.y < b.y + bSize && a.y + aSize > b.y;
  }

  root.querySelector('[data-act="run"]').onclick = startRun;
  root.querySelector('[data-act="edit"]').onclick = endRun;
  root.querySelector('[data-act="new"]').onclick = () => {
    if (!confirm("Start a new scene? This discards the current one.")) return;
    model = newScene();
    selectedId = null;
    render();
  };

  // Publish — export the scene as a self-contained HTML5 game.
  root.querySelector('[data-act="publish"]').onclick = async () => {
    const title = prompt("Game title?", model.name || "My Game");
    if (!title) return;
    const description = prompt("One-line description (optional):") || "";
    const html = exportGameHtml(model, title);
    try {
      await publishGame(ctx.user.uid, ctx.user.username, {
        title, description, code: html, thumb: model.sprites[0]?.value || "🎮",
        multiplayer: !!model.multiplayer
      });
      alert(`Published "${title}" to Community Hub.`);
    } catch (e) {
      alert("Publish failed: " + e.message);
    }
  };

  render();
}

function exportGameHtml(model, title) {
  // Serialize the model and embed a tiny runtime.
  const data = JSON.stringify(model);
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;background:${model.bg};color:#fff;font-family:system-ui;overflow:hidden;height:100%}
  #stage{position:relative;width:100vw;height:100vh;overflow:hidden;outline:none}
  .sprite{position:absolute;display:flex;align-items:center;justify-content:center;line-height:1;user-select:none}
  .sprite img{width:100%;height:100%;object-fit:contain;pointer-events:none}
  #msg{position:absolute;top:10px;left:50%;transform:translateX(-50%);padding:8px 16px;background:rgba(0,0,0,0.55);border-radius:6px;font-size:14px}
</style></head>
<body>
  <div id="stage" tabindex="0"></div>
  <div id="msg">Arrow keys to move</div>
  <script>
    const model = ${data};
    const stage = document.getElementById('stage');
    const msg = document.getElementById('msg');
    let mpRoom = null;
    let remotePositions = {};
    function render() {
      const local = model.sprites.map(s => {
        const filter = s.role === 'goal' ? 'drop-shadow(0 0 8px gold)' : s.role === 'hazard' ? 'drop-shadow(0 0 8px #ff3344)' : s.role === 'player' ? 'drop-shadow(0 0 6px #5aa9ff)' : 'none';
        const inner = s.kind === 'image' ? '<img src="' + s.value + '">' : s.value;
        return '<div class="sprite" data-id="' + s.id + '" style="left:' + s.x + 'px;top:' + s.y + 'px;width:' + s.size + 'px;height:' + s.size + 'px;font-size:' + (s.size*0.8) + 'px;filter:' + filter + '">' + inner + '</div>';
      }).join('');
      const remotes = Object.entries(remotePositions || {}).filter(([uid]) => !mpRoom || uid !== mpRoom.iAm.uid).map(([uid, p]) => {
        const size = p.size || 48;
        const inner = p.kind === 'image' ? '<img src="' + p.value + '">' : (p.value || '●');
        return '<div class="sprite" data-remote="' + uid + '" style="left:' + (p.x || 0) + 'px;top:' + (p.y || 0) + 'px;width:' + size + 'px;height:' + size + 'px;font-size:' + (size*0.8) + 'px;filter:drop-shadow(0 0 6px #7cc7ff);opacity:.86">' + inner + '</div>';
      }).join('');
      stage.innerHTML = local + remotes;
    }
    const player = model.sprites.find(s => s.role === 'player');
    if (!player) { msg.textContent = 'No player set in editor.'; render(); }
    else {
      const start = { x: player.x, y: player.y };
      const keys = {};
      stage.addEventListener('keydown', e => { keys[e.key] = 1; if (e.key.startsWith('Arrow')) e.preventDefault(); });
      stage.addEventListener('keyup', e => { keys[e.key] = 0; });
      stage.focus();
      function rectOverlap(a, aSize, b, bSize) {
        return a.x < b.x + bSize && a.x + aSize > b.x && a.y < b.y + bSize && a.y + aSize > b.y;
      }
      function step() {
        const speed = 4;
        let dx = 0, dy = 0;
        if (keys.ArrowLeft) dx -= speed;
        if (keys.ArrowRight) dx += speed;
        if (keys.ArrowUp) dy -= speed;
        if (keys.ArrowDown) dy += speed;
        const next = { x: player.x + dx, y: player.y + dy };
        let blocked = false;
        for (const w of model.sprites) if (w.role === 'wall' && rectOverlap(next, player.size, w, w.size)) { blocked = true; break; }
        if (!blocked) { player.x = next.x; player.y = next.y; }
        const W = innerWidth, H = innerHeight;
        player.x = Math.max(0, Math.min(W - player.size, player.x));
        player.y = Math.max(0, Math.min(H - player.size, player.y));
        for (const o of model.sprites) {
          if (o === player) continue;
          if (rectOverlap(player, player.size, o, o.size)) {
            if (o.role === 'goal') { msg.textContent = '🎉 You won!'; render(); return; }
            if (o.role === 'hazard') { player.x = start.x; player.y = start.y; }
          }
        }
        render();
        if (mpRoom) mpRoom.set('playerPositions/' + mpRoom.iAm.uid, {
          x: player.x, y: player.y, size: player.size, kind: player.kind, value: player.value
        }).catch(() => {});
        requestAnimationFrame(step);
      }
      render();
      setupMultiplayer();
      requestAnimationFrame(step);
    }
    async function setupMultiplayer() {
      if (!model.multiplayer || !window.bz?.multiplayer || !player) return;
      try {
        mpRoom = await window.bz.multiplayer.join({
          gameId: ${JSON.stringify(title.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40) || "engine-game")},
          roomId: window.__blizzardRoomCode || undefined,
          maxPlayers: 4
        });
        msg.textContent = 'Room ' + mpRoom.id + ' · arrow keys to move';
        mpRoom.onUpdate('playerPositions', positions => { remotePositions = positions || {}; render(); });
      } catch (e) {
        msg.textContent = 'Multiplayer unavailable: ' + e.message;
      }
    }
  <\/script>
</body></html>`;
}
