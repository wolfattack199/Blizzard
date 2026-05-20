// Inbox — Discord-style real-time chat, with email semantics (subject + threads).
// Listing looks like an email inbox; opening a thread is real-time chat.

import {
  subscribeMyMailThreads, getMailThread, subscribeMailMessages, sendMailMessage,
  markMailRead, deleteMailThread, createMailThread, lookupUidByUsername, loadUser
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";
import { avatarHtml } from "../os/avatar.js";
import { pickUser } from "../os/userpicker.js";

export async function mountInbox(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="inbox">
        <div class="inbox-side">
          <div class="inbox-side-head">
            <button class="primary" data-act="compose" style="width:100%">✉️ New message</button>
          </div>
          <div class="inbox-threads" data-bind="threads">Loading…</div>
        </div>
        <div class="inbox-main" data-bind="main">
          <div class="inbox-empty">Select a thread, or start a new message.</div>
        </div>
      </div>
    </div>
  `;

  const threadsEl = root.querySelector('[data-bind="threads"]');
  const mainEl    = root.querySelector('[data-bind="main"]');
  let threads = [];
  let activeTid = null;
  let activeMsgUnsub = null;

  const unsubInbox = subscribeMyMailThreads(ctx.user.uid, (list) => {
    threads = list;
    renderThreads();
  });

  function renderThreads() {
    if (threads.length === 0) {
      threadsEl.innerHTML = `<div class="muted" style="padding:24px;text-align:center;font-size:12px">No messages yet. Click "New message" to send one.</div>`;
      return;
    }
    threadsEl.innerHTML = threads.map((t) => {
      const av = avatarHtml({ uid: t.otherUid, username: t.otherUsername });
      return `
        <div class="inbox-thread${t.tid === activeTid ? " active" : ""}${t.unread ? " unread" : ""}" data-tid="${escapeHtml(t.tid)}">
          <div class="inbox-thread-avatar" style="${av.style}">${escapeHtml(av.text)}</div>
          <div class="inbox-thread-meta">
            <div class="inbox-thread-top">
              <span class="inbox-thread-from">@${escapeHtml(t.otherUsername || "anon")}</span>
              <span class="inbox-thread-time">${shortTime(t.lastTs)}</span>
            </div>
            <div class="inbox-thread-subject">${escapeHtml(t.subject || "(no subject)")}</div>
            <div class="inbox-thread-snippet">${escapeHtml(t.lastFrom || "")}: ${escapeHtml(t.lastSnippet || "")}</div>
          </div>
          ${t.unread ? '<span class="inbox-thread-dot"></span>' : ""}
        </div>
      `;
    }).join("");
    threadsEl.querySelectorAll(".inbox-thread").forEach((el) =>
      el.addEventListener("click", () => openThread(el.dataset.tid))
    );
  }

  async function openThread(tid) {
    activeTid = tid;
    renderThreads();
    markMailRead(ctx.user.uid, tid);

    if (activeMsgUnsub) activeMsgUnsub();

    const thread = await getMailThread(tid);
    if (!thread) {
      mainEl.innerHTML = `<div class="inbox-empty">Thread not found.</div>`;
      return;
    }
    const otherEntries = Object.entries(thread.participants || {}).filter(([uid]) => uid !== ctx.user.uid);
    const [otherUid, otherUsername] = otherEntries[0] || ["", "unknown"];
    const av = avatarHtml({ uid: otherUid, username: otherUsername });

    mainEl.innerHTML = `
      <div class="inbox-thread-head">
        <div class="inbox-thread-avatar lg" style="${av.style}">${escapeHtml(av.text)}</div>
        <div style="flex:1;min-width:0;user-select:text">
          <div class="inbox-thread-subject" style="font-size:16px;font-weight:600;color:var(--text-0)">${escapeHtml(thread.subject || "(no subject)")}</div>
          <div class="inbox-thread-from" style="font-size:12px;color:var(--text-2)">to @${escapeHtml(otherUsername)} · started ${new Date(thread.createdAt || 0).toLocaleString()}</div>
        </div>
        <button class="danger" data-act="trash" style="font-size:11.5px">Delete from inbox</button>
      </div>
      <div class="inbox-msgs" data-bind="msgs"></div>
      <div class="inbox-input-bar">
        <textarea data-bind="input" placeholder="Reply…" rows="2"></textarea>
        <button class="primary" data-act="send">Send</button>
      </div>
    `;

    const msgsEl = mainEl.querySelector('[data-bind="msgs"]');
    const inputEl = mainEl.querySelector('[data-bind="input"]');

    activeMsgUnsub = subscribeMailMessages(tid, (m) => {
      const isMe = m.fromUid === ctx.user.uid;
      const mAv = avatarHtml({ uid: m.fromUid, username: m.fromUsername });
      const div = document.createElement("div");
      div.className = "inbox-msg" + (isMe ? " me" : "");
      div.innerHTML = `
        <div class="inbox-msg-avatar" style="${mAv.style}">${escapeHtml(mAv.text)}</div>
        <div class="inbox-msg-body">
          <div class="inbox-msg-head">
            <span>${escapeHtml(m.fromUsername || "?")}</span>
            <span class="muted" style="font-size:11px">${shortTime(m.ts)}</span>
          </div>
          <div class="inbox-msg-text">${linkify(escapeHtml(m.text || ""))}</div>
        </div>
      `;
      msgsEl.appendChild(div);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    });

    const send = () => {
      const text = inputEl.value.trim();
      if (!text) return;
      sendMailMessage(tid, ctx.user.uid, ctx.user.username, text);
      inputEl.value = "";
    };
    mainEl.querySelector('[data-act="send"]').onclick = send;
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    mainEl.querySelector('[data-act="trash"]').onclick = async () => {
      if (!confirm("Remove this thread from your inbox? The other person keeps their copy.")) return;
      await deleteMailThread(ctx.user.uid, tid);
      activeTid = null;
      mainEl.innerHTML = `<div class="inbox-empty">Select a thread, or start a new message.</div>`;
    };
  }

  root.querySelector('[data-act="compose"]').addEventListener("click", () => openCompose(ctx, openThread));

  return () => {
    if (unsubInbox) unsubInbox();
    if (activeMsgUnsub) activeMsgUnsub();
  };
}

export function openMailCompose(ctx, onSent) { return openCompose(ctx, onSent); }
function openCompose(ctx, onSent) {
  const overlay = document.createElement("div");
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(5,9,18,0.7);z-index:5000;display:flex;align-items:center;justify-content:center`;
  overlay.innerHTML = `
    <div style="width:520px;max-width:96vw;background:var(--bg-1);border:1px solid var(--line-strong);border-radius:10px;padding:18px;box-shadow:var(--shadow-2);user-select:text">
      <h3 style="margin:0 0 12px;font-weight:500">New message</h3>
      <div class="col" style="gap:10px">
        <div class="col" style="gap:4px;display:flex;flex-direction:column">
          <span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">To</span>
          <button id="nm-to-btn" style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-2);text-align:left">Pick a user…</button>
          <input id="nm-to" type="hidden">
        </div>
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Subject</span>
          <input id="nm-subj" type="text"
            style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none"></label>
        <label class="col" style="gap:4px"><span class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Message</span>
          <textarea id="nm-body" rows="6" placeholder="Write your message…"
            style="padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none;resize:vertical;font-family:inherit"></textarea></label>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px;gap:8px">
        <button data-act="cancel">Cancel</button>
        <button class="primary" data-act="send">Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  let pickedRecipient = null;
  overlay.querySelector("#nm-to-btn").onclick = async () => {
    const picked = await pickUser({
      title: "Send to",
      label: "Username",
      excludeUid: ctx.user.uid,
      submitLabel: "Pick"
    });
    if (!picked) return;
    pickedRecipient = picked;
    const btn = overlay.querySelector("#nm-to-btn");
    btn.textContent = "@" + picked.username + "  (change…)";
    btn.style.color = "var(--text-0)";
  };
  overlay.querySelector('[data-act="cancel"]').onclick = () => overlay.remove();
  overlay.querySelector('[data-act="send"]').onclick = async () => {
    if (!pickedRecipient) { alert("Pick a recipient first."); return; }
    const subject = overlay.querySelector("#nm-subj").value.trim();
    const body = overlay.querySelector("#nm-body").value.trim();
    if (!subject) { alert("Subject is required."); return; }
    try {
      const tid = await createMailThread(
        ctx.user.uid, ctx.user.username,
        pickedRecipient.uid, pickedRecipient.username,
        subject, body
      );
      overlay.remove();
      onSent(tid);
    } catch (e) {
      alert("Failed to send: " + e.message);
    }
  };
}

function shortTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}
