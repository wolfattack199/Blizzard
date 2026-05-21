// Community Hub — browse, create, and download web games to the local FS.
import { listGames, publishGame, getGame } from "../firebase.js";
import * as FS from "../fs.js";
import { escapeHtml } from "../os/wm.js";

export async function mountCommunity(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="app-toolbar">
        <input type="search" class="grow" placeholder="Search games…" data-bind="search" />
        <button class="primary" data-act="create">＋ Publish a game</button>
        <button data-act="refresh">⟳</button>
      </div>
      <div class="community">
        <div class="community-grid" data-bind="grid"></div>
      </div>
    </div>
  `;

  const grid    = root.querySelector('[data-bind="grid"]');
  const search  = root.querySelector('[data-bind="search"]');
  let allGames  = [];

  async function refresh() {
    allGames = await listGames();
    render();
  }

  function render() {
    const q = (search.value || "").toLowerCase();
    const filtered = allGames.filter((g) =>
      !q || (g.title || "").toLowerCase().includes(q) || (g.description || "").toLowerCase().includes(q)
    );
    if (filtered.length === 0) {
      grid.innerHTML = `<div class="muted" style="grid-column:1/-1;padding:30px;text-align:center">No games yet. Be the first to publish one!</div>`;
      return;
    }
    grid.innerHTML = filtered.map((g) => `
      <div class="game-card" data-id="${escapeHtml(g.id)}">
        <div class="game-card-thumb">${escapeHtml(g.thumb || "🎮")}</div>
        <div class="game-card-body">
          <div class="game-card-title">${escapeHtml(g.title || "Untitled")}</div>
          <div class="game-card-author">by @${escapeHtml(g.authorUsername || "anon")}${g.multiplayer ? ' · <span class="pill">multiplayer</span>' : ""}</div>
          <div class="game-card-desc">${escapeHtml((g.description || "").slice(0, 140))}</div>
          <div class="game-card-footer">
            <button data-act="play">Play</button>
            <button class="primary" data-act="install">Install</button>
          </div>
        </div>
      </div>
    `).join("");

    grid.querySelectorAll(".game-card").forEach((card) => {
      card.querySelector('[data-act="play"]').addEventListener("click", () => playGame(card.dataset.id));
      card.querySelector('[data-act="install"]').addEventListener("click", () => installGame(card.dataset.id));
    });
  }

  async function playGame(id) {
    const g = await getGame(id);
    if (!g) return;
    let code = g.code || "";
    if (g.multiplayer) {
      const room = prompt("Room code to join, or leave blank to create one:") || "";
      code = injectRoomCode(code, room.trim().toUpperCase());
    }
    // Open in a Blizzard browser tab (no pop-up).
    ctx.launchApp("browser", { initialHtml: code, initialTitle: g.title || "Game" });
  }

  async function installGame(id) {
    const g = await getGame(id);
    if (!g) return;
    const safeName = (g.title || "game").replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "game";
    // Save to the user's account-synced files so it follows them to other devices.
    const path = `/Cloud/My Files/Games/${safeName}.blz`;
    try {
      await FS.write(path, g.code || "");
      alert(`Installed "${g.title}" to ${path}\nOpen it from File Explorer (Cloud → My Files → Games).`);
    } catch (e) {
      alert("Install failed: " + e.message);
    }
  }

  // Publish flow
  root.querySelector('[data-act="create"]').addEventListener("click", () => openPublishDialog(ctx, refresh));
  root.querySelector('[data-act="refresh"]').addEventListener("click", refresh);
  search.addEventListener("input", render);

  await refresh();
}

function openPublishDialog(ctx, onDone) {
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; inset: 0; background: rgba(5,9,18,0.7); z-index: 5000;
    display: flex; align-items: center; justify-content: center;
  `;
  overlay.innerHTML = `
    <div style="width: 560px; max-width: 92vw; background: var(--bg-1); border: 1px solid var(--line-strong); border-radius: 10px; padding: 18px; box-shadow: var(--shadow-2); user-select: text;">
      <h3 style="margin: 0 0 12px; font-weight: 500;">Publish a game</h3>
      <div class="col" style="gap: 10px;">
        <label class="col" style="gap: 4px;">
          <span class="muted" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Title</span>
          <input class="grow" type="text" id="pg-title" placeholder="My Awesome Game"
            style="padding: 8px 10px; background: rgba(0,0,0,0.3); border: 1px solid var(--line); border-radius: 5px; color: var(--text-0); outline: none;">
        </label>
        <label class="col" style="gap: 4px;">
          <span class="muted" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Description</span>
          <textarea id="pg-desc" rows="2"
            style="padding: 8px 10px; background: rgba(0,0,0,0.3); border: 1px solid var(--line); border-radius: 5px; color: var(--text-0); outline: none; resize: vertical; font-family: inherit;"></textarea>
        </label>
        <label class="col" style="gap: 4px;">
          <span class="muted" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Emoji thumbnail</span>
          <input id="pg-thumb" type="text" maxlength="4" placeholder="🎮"
            style="padding: 8px 10px; background: rgba(0,0,0,0.3); border: 1px solid var(--line); border-radius: 5px; color: var(--text-0); outline: none; width: 80px;">
        </label>
        <label class="col" style="gap: 4px;">
          <span class="muted" style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;">Game code (single HTML file)</span>
          <textarea id="pg-code" rows="10" placeholder="<!doctype html>..."
            style="padding: 8px 10px; background: rgba(0,0,0,0.3); border: 1px solid var(--line); border-radius: 5px; color: var(--text-0); outline: none; font-family: var(--mono); font-size: 12px; resize: vertical;"></textarea>
        </label>
      </div>
      <div class="row" style="justify-content: flex-end; margin-top: 14px;">
        <button id="pg-cancel">Cancel</button>
        <button class="primary" id="pg-submit">Publish</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#pg-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#pg-submit").onclick = async () => {
    const title = overlay.querySelector("#pg-title").value.trim();
    const description = overlay.querySelector("#pg-desc").value.trim();
    const thumb = overlay.querySelector("#pg-thumb").value.trim() || "🎮";
    const code = overlay.querySelector("#pg-code").value.trim() ||
      "<!doctype html><body><h1>Hello!</h1></body>";
    if (!title) { alert("Please enter a title."); return; }
    await publishGame(ctx.user.uid, ctx.user.username, { title, description, thumb, code, multiplayer: false });
    overlay.remove();
    onDone();
  };
}

function injectRoomCode(html, roomCode) {
  const script = `<script>window.__blizzardRoomCode=${JSON.stringify(roomCode || "")};<\/script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + script);
  return script + html;
}
