// Shared user picker with autocomplete. Pulls the full user list from Firebase
// (cached for a short time) and shows live suggestions as the user types.
import { listUsers, lookupUidByUsername } from "../firebase.js";
import { escapeHtml } from "./wm.js";
import { avatarHtml } from "./avatar.js";

let cache = null;
let cacheTime = 0;
const TTL_MS = 30_000;

export async function getAllUsersCached() {
  if (cache && Date.now() - cacheTime < TTL_MS) return cache;
  cache = await listUsers();
  cacheTime = Date.now();
  return cache;
}

export function invalidateUserCache() {
  cache = null;
}

/**
 * Pick a user with autocomplete. Resolves to { uid, username } or null on cancel.
 * Options: { title, label, excludeUid, submitLabel }
 */
export async function pickUser({ title = "Pick a user", label = "Username", excludeUid = null, submitLabel = "OK" } = {}) {
  const users = (await getAllUsersCached()).filter((u) => !excludeUid || u.uid !== excludeUid);
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(5,9,18,0.7);z-index:7000;display:flex;align-items:center;justify-content:center`;
    overlay.innerHTML = `
      <div style="width:380px;background:var(--bg-1);border:1px solid var(--line-strong);border-radius:10px;padding:18px;box-shadow:var(--shadow-2);user-select:text">
        <h3 style="margin:0 0 12px;font-weight:500">${escapeHtml(title)}</h3>
        <label class="col" style="gap:4px;display:flex;flex-direction:column">
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">${escapeHtml(label)}</span>
          <input id="up-q" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
            style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none">
        </label>
        <div id="up-suggestions" class="up-suggestions"></div>
        <div class="row" style="justify-content:flex-end;margin-top:14px;gap:8px">
          <button id="up-cancel">Cancel</button>
          <button class="primary" id="up-ok">${escapeHtml(submitLabel)}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector("#up-q");
    const sug = overlay.querySelector("#up-suggestions");
    let activeIdx = 0;
    let matches = [];

    function close(result) {
      overlay.remove();
      resolve(result);
    }

    function render() {
      const q = (input.value || "").trim().toLowerCase();
      matches = q
        ? users.filter((u) => (u.username || "").toLowerCase().includes(q))
                .sort((a, b) => {
                  const ai = (a.username || "").toLowerCase().indexOf(q);
                  const bi = (b.username || "").toLowerCase().indexOf(q);
                  if (ai !== bi) return ai - bi;
                  return (a.username || "").localeCompare(b.username || "");
                })
                .slice(0, 8)
        : users.slice(0, 8);
      activeIdx = Math.min(activeIdx, matches.length - 1);
      if (activeIdx < 0) activeIdx = 0;
      if (matches.length === 0) {
        sug.innerHTML = `<div class="up-suggestion empty">No users match.</div>`;
        return;
      }
      sug.innerHTML = matches.map((u, i) => {
        const av = avatarHtml(u);
        return `
          <div class="up-suggestion${i === activeIdx ? " active" : ""}" data-idx="${i}">
            <span class="up-av" style="${av.style}">${escapeHtml(av.text)}</span>
            <span>@${escapeHtml(u.username || "anon")}</span>
          </div>`;
      }).join("");
      sug.querySelectorAll(".up-suggestion[data-idx]").forEach((el) =>
        el.addEventListener("click", () => {
          activeIdx = parseInt(el.dataset.idx, 10);
          submit();
        })
      );
    }

    async function submit() {
      const typed = input.value.trim();
      const picked = matches[activeIdx];
      if (picked) return close({ uid: picked.uid, username: picked.username });
      if (!typed) return close(null);
      // Fall back: look up by exact username (in case user typed someone not in cache yet)
      try {
        const uid = await lookupUidByUsername(typed);
        if (!uid) { alert(`No user named "${typed}".`); return; }
        if (excludeUid && uid === excludeUid) { alert("That's you."); return; }
        close({ uid, username: typed });
      } catch (e) {
        alert("Lookup failed: " + e.message);
      }
    }

    overlay.querySelector("#up-cancel").onclick = () => close(null);
    overlay.querySelector("#up-ok").onclick = submit;
    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(null); }
      else if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(matches.length - 1, activeIdx + 1); render(); }
      else if (e.key === "ArrowUp")   { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); render(); }
    });

    render();
    setTimeout(() => input.focus(), 30);
  });
}
