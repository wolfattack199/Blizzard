// Messenger — Discord-like text chat with:
//   - Built-in "Blizzard" server (everyone, default channels)
//   - User-created servers (invite by username, custom channels)
//   - Direct messages
import {
  ensureDefaultChannels, listChannels, subscribeChannel, sendChannelMessage,
  subscribeDM, sendDM, listUsers, loadUser,
  listMyServers, createServer, getServer, inviteToServer,
  addChannelToServer, subscribeServerChannel, sendServerMessage,
  lookupUidByUsername,
  subscribeMyMailThreads, getMailThread, subscribeMailMessages, sendMailMessage,
  markMailRead, deleteMailThread, createMailThread
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";
import { avatarHtml } from "../os/avatar.js";
import { pickUser } from "../os/userpicker.js";
import { openMailCompose } from "./inbox.js";

// Cache of users for avatar lookups in the message stream
const userCache = new Map();
async function getCachedUser(uid) {
  if (!uid) return null;
  if (userCache.has(uid)) return userCache.get(uid);
  const p = loadUser(uid);
  userCache.set(uid, p);
  const v = await p;
  userCache.set(uid, v);
  return v;
}

export async function mountMessenger(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="msgr">
        <div class="msgr-servers" data-bind="servers"></div>
        <div class="msgr-channels">
          <div class="msgr-channels-header">
            <span data-bind="srv-title">Blizzard</span>
            <button data-act="srv-menu" style="padding:2px 6px;font-size:11px">⋯</button>
          </div>
          <div class="msgr-channel-list" data-bind="chan-list"></div>
        </div>
        <div class="msgr-main">
          <div class="msgr-header" data-bind="chan-title"># general</div>
          <div class="msgr-messages" data-bind="messages"></div>
          <div class="msgr-input-bar">
            <textarea class="msgr-input" rows="2" placeholder="Message…" data-bind="input"></textarea>
          </div>
        </div>
      </div>
    </div>
  `;

  const serversEl = root.querySelector('[data-bind="servers"]');
  const chanList  = root.querySelector('[data-bind="chan-list"]');
  const messages  = root.querySelector('[data-bind="messages"]');
  const inputEl   = root.querySelector('[data-bind="input"]');
  const chanTitle = root.querySelector('[data-bind="chan-title"]');
  const srvTitle  = root.querySelector('[data-bind="srv-title"]');

  await ensureDefaultChannels();

  // Server states:
  //   serverMode: "blizzard" | "dm" | server-id
  let serverMode = "blizzard";
  let currentView = { kind: "channel", id: "general", label: "general" };
  let unsubMessages = null;
  let userServers = [];
  let unsubInboxList = null;
  let inboxThreads = [];

  async function refreshServers() {
    userServers = await listMyServers(ctx.user.uid);
    const items = [
      { id: "blizzard", letter: "B", title: "Blizzard (public)" },
      ...userServers.map((s) => ({ id: s.id, letter: (s.name || "?")[0].toUpperCase(), title: s.name })),
      { id: "dm",    letter: "@", title: "Direct messages" },
      { id: "inbox", letter: "✉", title: "Inbox (threaded mail)" },
      { id: "__new", letter: "+", title: "Create a server" }
    ];
    serversEl.innerHTML = items.map((s) => `
      <div class="msgr-server${s.id === serverMode ? " active" : ""}" data-server="${escapeHtml(s.id)}" title="${escapeHtml(s.title)}">${escapeHtml(s.letter)}</div>
    `).join("");
    serversEl.querySelectorAll(".msgr-server").forEach((el) =>
      el.addEventListener("click", () => switchServer(el.dataset.server))
    );
  }

  async function switchServer(id) {
    if (id === "__new") {
      const name = prompt("Server name?");
      if (!name) return;
      const sid = await createServer(ctx.user.uid, name);
      await refreshServers();
      switchServer(sid);
      return;
    }
    serverMode = id;
    if (unsubMessages) { unsubMessages(); unsubMessages = null; }
    if (unsubInboxList) { unsubInboxList(); unsubInboxList = null; }
    clearMessages();

    if (id === "inbox") {
      srvTitle.textContent = "Inbox";
      chanTitle.textContent = "Select a thread, or compose a new message";
      chanList.innerHTML = `
        <div class="msgr-dm-toolbar">
          <button class="primary" data-act="compose-mail" style="width:100%">✉️ New message</button>
        </div>
        <div data-bind="inbox-threads" style="flex:1;overflow-y:auto">Loading…</div>
      `;
      const threadsBox = chanList.querySelector('[data-bind="inbox-threads"]');
      unsubInboxList = subscribeMyMailThreads(ctx.user.uid, (list) => {
        inboxThreads = list;
        renderInboxThreads(threadsBox);
      });
      chanList.querySelector('[data-act="compose-mail"]').onclick = () =>
        openMailCompose(ctx, (tid) => openMailThread(tid));
      // Refresh server highlight
      serversEl.querySelectorAll(".msgr-server").forEach((el) =>
        el.classList.toggle("active", el.dataset.server === id)
      );
      return;
    }

    if (id === "blizzard") {
      srvTitle.textContent = "Blizzard";
      const channels = await listChannels();
      chanList.innerHTML = `<div class="msgr-channel-section">Text channels</div>` +
        channels.map((c) => `
          <div class="msgr-channel" data-channel="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name || c.id)}">
            <span class="msgr-channel-prefix">#</span><span>${escapeHtml(c.name || c.id)}</span>
          </div>
        `).join("");
      chanList.querySelectorAll("[data-channel]").forEach((el) =>
        el.addEventListener("click", () => switchToChannel(el.dataset.channel, el.dataset.name))
      );
      switchToChannel("general", "general");
    } else if (id === "dm") {
      srvTitle.textContent = "Direct messages";
      const users = (await listUsers()).filter((u) => u.uid !== ctx.user.uid);
      chanList.innerHTML = `
        <div class="msgr-dm-toolbar">
          <input type="search" data-bind="dm-q" placeholder="Find a user…">
          <button class="primary" data-act="add-dm">＋ Add</button>
        </div>
        <div class="msgr-channel-section">People (${users.length})</div>
        <div data-bind="dm-people">
          ${users.length === 0
            ? `<div class="msgr-empty">No other users yet. Invite a friend to sign up!</div>`
            : users.map((u) => dmRowHtml(u)).join("")}
        </div>
      `;

      const filterIn = chanList.querySelector('[data-bind="dm-q"]');
      const peopleEl = chanList.querySelector('[data-bind="dm-people"]');

      const wireRows = () => peopleEl.querySelectorAll("[data-uid]").forEach((el) =>
        el.addEventListener("click", () => switchToDM(el.dataset.uid, el.dataset.name))
      );
      wireRows();

      filterIn.addEventListener("input", () => {
        const q = filterIn.value.toLowerCase().trim();
        const filtered = users.filter((u) => (u.username || "").toLowerCase().includes(q));
        peopleEl.innerHTML = filtered.length === 0
          ? `<div class="msgr-empty">No matches.</div>`
          : filtered.map(dmRowHtml).join("");
        wireRows();
      });

      chanList.querySelector('[data-act="add-dm"]').addEventListener("click", async () => {
        const picked = await pickUser({
          title: "Start a DM",
          label: "Username",
          excludeUid: ctx.user.uid,
          submitLabel: "Open chat"
        });
        if (picked) switchToDM(picked.uid, picked.username);
      });

      chanTitle.textContent = "Select a person to message";
    } else {
      // User server
      const server = await getServer(id);
      if (!server) return;
      srvTitle.textContent = server.name;
      const channels = Object.entries(server.channels || {}).map(([cid, c]) => ({ id: cid, name: c.name || cid }));
      chanList.innerHTML = `
        <div class="msgr-channel-section" style="display:flex;justify-content:space-between;align-items:center">
          <span>Text channels</span>
          <button data-act="new-chan" style="padding:1px 6px;font-size:11px">+</button>
        </div>
        ${channels.map((c) => `
          <div class="msgr-channel" data-channel="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}">
            <span class="msgr-channel-prefix">#</span><span>${escapeHtml(c.name)}</span>
          </div>
        `).join("")}
        <div class="msgr-channel-section" style="margin-top:10px">Members</div>
        ${(await renderMembers(server)).join("")}
      `;
      chanList.querySelectorAll("[data-channel]").forEach((el) =>
        el.addEventListener("click", () => switchToServerChannel(id, el.dataset.channel, el.dataset.name))
      );
      const newChan = chanList.querySelector('[data-act="new-chan"]');
      if (newChan) newChan.onclick = async () => {
        const n = prompt("Channel name?");
        if (!n) return;
        await addChannelToServer(id, n);
        switchServer(id);
      };
      if (channels.length > 0) switchToServerChannel(id, channels[0].id, channels[0].name);
      else chanTitle.textContent = "No channels yet";
    }

    // Refresh server highlight
    serversEl.querySelectorAll(".msgr-server").forEach((el) =>
      el.classList.toggle("active", el.dataset.server === id)
    );
  }

  async function renderMembers(server) {
    const uids = Object.keys(server.members || {});
    const users = await listUsers();
    return uids.map((uid) => {
      const u = users.find((x) => x.uid === uid);
      return `<div class="msgr-channel" style="cursor:default">
        <span class="msgr-channel-prefix">●</span><span>@${escapeHtml(u?.username || uid.slice(0, 6))}</span>
      </div>`;
    });
  }

  // Server "..." menu (invite, etc.)
  root.querySelector('[data-act="srv-menu"]').addEventListener("click", async () => {
    if (serverMode === "blizzard" || serverMode === "dm") return;
    const picked = await pickUser({
      title: "Invite to server",
      label: "Username",
      excludeUid: ctx.user.uid,
      submitLabel: "Invite"
    });
    if (!picked) return;
    await inviteToServer(serverMode, picked.uid);
    alert(`Invited @${picked.username}.`);
  });

  function clearMessages() { messages.innerHTML = ""; }
  function appendMessage(m) {
    const div = document.createElement("div");
    div.className = "msgr-msg";
    const av = avatarHtml({ uid: m.uid, username: m.username });
    div.innerHTML = `
      <div class="msgr-avatar" style="${av.style}">${escapeHtml(av.text)}</div>
      <div class="msgr-msg-body">
        <div class="msgr-msg-head">
          <span class="msgr-msg-user">${escapeHtml(m.username || "unknown")}</span>
          <span class="msgr-msg-time">${formatTime(m.ts)}</span>
        </div>
        <div class="msgr-msg-text">${linkify(escapeHtml(m.text || ""))}</div>
      </div>
    `;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    // Upgrade to the user's real avatar if available
    if (m.uid) {
      getCachedUser(m.uid).then((u) => {
        if (!u) return;
        const a2 = avatarHtml(u);
        const el = div.querySelector(".msgr-avatar");
        if (el && a2.style !== av.style) {
          el.setAttribute("style", a2.style);
          el.textContent = a2.text;
        }
      });
    }
  }

  function switchToChannel(id, label) {
    currentView = { kind: "channel", id, label };
    chanTitle.textContent = "# " + label;
    clearMessages();
    if (unsubMessages) unsubMessages();
    unsubMessages = subscribeChannel(id, appendMessage);
    inputEl.placeholder = `Message #${label}`;
    highlightActive();
  }

  function switchToDM(uid, username) {
    currentView = { kind: "dm", uid, username };
    chanTitle.textContent = "@ " + username;
    clearMessages();
    if (unsubMessages) unsubMessages();
    unsubMessages = subscribeDM(ctx.user.uid, uid, appendMessage);
    inputEl.placeholder = `Message @${username}`;
    highlightActive();
  }

  function switchToServerChannel(serverId, channelId, label) {
    currentView = { kind: "server", serverId, channelId, label };
    chanTitle.textContent = "# " + label;
    clearMessages();
    if (unsubMessages) unsubMessages();
    unsubMessages = subscribeServerChannel(serverId, channelId, appendMessage);
    inputEl.placeholder = `Message #${label}`;
    highlightActive();
  }

  function highlightActive() {
    chanList.querySelectorAll(".msgr-channel").forEach((el) => {
      const isChan   = currentView.kind === "channel" && el.dataset.channel === currentView.id;
      const isDM     = currentView.kind === "dm" && el.dataset.uid === currentView.uid;
      const isSChan  = currentView.kind === "server" && el.dataset.channel === currentView.channelId;
      el.classList.toggle("active", isChan || isDM || isSChan);
    });
  }

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;
      if (currentView.kind === "channel") {
        sendChannelMessage(currentView.id, ctx.user.uid, ctx.user.username, text);
      } else if (currentView.kind === "dm") {
        sendDM(ctx.user.uid, currentView.uid, ctx.user.uid, ctx.user.username, text);
      } else if (currentView.kind === "server") {
        sendServerMessage(currentView.serverId, currentView.channelId, ctx.user.uid, ctx.user.username, text);
      } else if (currentView.kind === "mail" && currentView.mailSend) {
        currentView.mailSend(text);
      } else return;
      inputEl.value = "";
    }
  });

  function renderInboxThreads(box) {
    if (inboxThreads.length === 0) {
      box.innerHTML = `<div class="muted" style="padding:20px;text-align:center;font-size:12px">No mail yet.</div>`;
      return;
    }
    box.innerHTML = inboxThreads.map((t) => {
      const av = avatarHtml({ uid: t.otherUid, username: t.otherUsername });
      const active = currentView.kind === "mail" && currentView.tid === t.tid;
      return `
        <div class="inbox-thread${active ? " active" : ""}${t.unread ? " unread" : ""}" data-tid="${escapeHtml(t.tid)}">
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
    box.querySelectorAll(".inbox-thread").forEach((el) =>
      el.addEventListener("click", () => openMailThread(el.dataset.tid))
    );
  }

  async function openMailThread(tid) {
    currentView = { kind: "mail", tid };
    markMailRead(ctx.user.uid, tid);
    const threadsBox = chanList.querySelector('[data-bind="inbox-threads"]');
    if (threadsBox) renderInboxThreads(threadsBox);

    const thread = await getMailThread(tid);
    if (!thread) {
      chanTitle.textContent = "Thread not found";
      clearMessages();
      return;
    }
    const otherEntries = Object.entries(thread.participants || {}).filter(([uid]) => uid !== ctx.user.uid);
    const [otherUid, otherUsername] = otherEntries[0] || ["", "unknown"];
    chanTitle.textContent = `✉ ${thread.subject || "(no subject)"} · @${otherUsername}`;
    clearMessages();
    if (unsubMessages) unsubMessages();
    unsubMessages = subscribeMailMessages(tid, (m) => {
      appendMessage({ uid: m.fromUid, username: m.fromUsername, text: m.text, ts: m.ts });
    });
    inputEl.placeholder = `Reply to ${thread.subject || "thread"}`;
    // Hijack the send for mail
    currentView.mailSend = (text) => sendMailMessage(tid, ctx.user.uid, ctx.user.username, text);
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

  await refreshServers();
  switchServer("blizzard");

  return () => {
    if (unsubMessages) unsubMessages();
    if (unsubInboxList) unsubInboxList();
  };
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return "Today at " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function linkify(s) {
  return s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function dmRowHtml(u) {
  const av = avatarHtml(u);
  return `
    <div class="msgr-channel msgr-dm-row" data-uid="${escapeHtml(u.uid)}" data-name="${escapeHtml(u.username)}">
      <span class="msgr-dm-avatar" style="${av.style}">${escapeHtml(av.text)}</span>
      <span>${escapeHtml(u.username)}</span>
    </div>
  `;
}
