import {
  requireRole, listModQueue, approveModQueueItem, rejectModQueueItem,
  issueWarning, setUserTimeoutByAdmin, requestTimeoutReview
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";

const OWNER_USERNAME = "wolfattack199";

export async function mountMod(root, ctx) {
  if ((ctx.user.username || "").toLowerCase() !== OWNER_USERNAME) {
    root.innerHTML = `
      <div class="app mod-console">
        <div style="padding:40px;text-align:center">
          <h2 style="color:var(--danger);margin-bottom:8px">Access denied</h2>
          <p class="muted">The Moderation Queue is restricted to the OS owner.</p>
        </div>
      </div>
    `;
    return;
  }
  root.innerHTML = `
    <div class="app mod-console">
      <div class="app-toolbar">
        <b>Moderation Queue</b>
        <span class="spacer"></span>
        <button data-act="refresh">Refresh</button>
      </div>
      <div data-bind="body" class="mod-body">Loading...</div>
    </div>
  `;
  const body = root.querySelector('[data-bind="body"]');
  let actor = null;

  try {
    actor = await requireRole(ctx.user.uid, "mod");
  } catch (e) {
    body.innerHTML = `<div class="mod-empty">Moderator access required.</div>`;
    return;
  }

  async function render() {
    const items = await listModQueue();
    if (items.length === 0) {
      body.innerHTML = `<div class="mod-empty">No flagged messages are waiting for review.</div>`;
      return;
    }
    body.innerHTML = items.map((item, index) => `
      <div class="mod-item" data-i="${index}">
        <div class="mod-item-head">
          <b>@${escapeHtml(item.senderUsername || "unknown")}</b>
          <span class="muted">${escapeHtml(item.scope || "")}</span>
          <span class="spacer"></span>
          <span class="pill">Under review</span>
        </div>
        <div class="mod-text">${escapeHtml(item.text || "")}</div>
        <div class="muted">Reasons: ${(item.reasons || []).map(escapeHtml).join(", ") || "flagged"} - ${new Date(item.ts || 0).toLocaleString()}</div>
        <div class="mod-actions">
          <button class="primary" data-act="approve">Approve</button>
          <button class="danger" data-act="reject">Reject</button>
          <button data-act="warn">Warn user</button>
          <button data-act="timeout">Timeout user</button>
        </div>
      </div>
    `).join("");
    body.querySelectorAll(".mod-item").forEach((row) => {
      const item = items[Number(row.dataset.i)];
      row.querySelector('[data-act="approve"]').onclick = async () => {
        await approveModQueueItem(ctx.user.uid, item);
        await render();
      };
      row.querySelector('[data-act="reject"]').onclick = async () => {
        await rejectModQueueItem(ctx.user.uid, item);
        await render();
      };
      row.querySelector('[data-act="warn"]').onclick = async () => {
        const text = prompt("Warning text", "Flagged content");
        if (!text) return;
        await issueWarning(ctx.user.uid, item.senderUid, text, "Flagged content");
      };
      row.querySelector('[data-act="timeout"]').onclick = async () => {
        const minutes = Number(prompt("Timeout minutes", "60"));
        if (!Number.isFinite(minutes) || minutes <= 0) return;
        if (actor.role === "admin") {
          await setUserTimeoutByAdmin(ctx.user.uid, item.senderUid, Date.now() + minutes * 60 * 1000, "Flagged content");
        } else {
          await requestTimeoutReview(ctx.user.uid, item.senderUid, minutes, "Flagged content");
          alert("Timeout request sent to admins.");
        }
      };
    });
  }

  root.querySelector('[data-act="refresh"]').onclick = render;
  await render();
}
