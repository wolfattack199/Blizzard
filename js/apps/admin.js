import {
  loadUser, listUsers, lookupUidByUsername, reauthenticateBlizzardUser,
  listReports, setReportStatusByAdmin, issueWarning, setUserTimeoutByAdmin,
  setUserRoleByAdmin, setAppBanByAdmin, globalBanUser,
  listAuditLog, saveModerationWordlists, subscribeModerationWordlists,
  requireRole, setQuotaTierByAdmin, adminBulkDeleteUserMessages
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";
import { avatarHtml } from "../os/avatar.js";

const TABS = ["reports", "users", "audit", "settings"];
const OWNER_USERNAME = "wolfattack199";

export async function mountAdmin(root, ctx) {
  // Owner-only — refuse to render anything for any other account.
  if ((ctx.user.username || "").toLowerCase() !== OWNER_USERNAME) {
    root.innerHTML = `
      <div class="app admin-console">
        <div class="admin-lock">
          <div class="admin-card" style="text-align:center">
            <h2 style="color:var(--danger)">Access denied</h2>
            <p class="muted">The Admin Console is restricted to the OS owner.</p>
          </div>
        </div>
      </div>
    `;
    return;
  }

  root.innerHTML = `
    <div class="app admin-console">
      <div class="admin-lock" data-bind="gate">
        <div class="admin-card">
          <h2>Admin Console</h2>
          <p class="muted">Type <b>ghiy</b> in taskbar search to find this window. Admin access still uses your normal Blizzard account.</p>
          <form data-bind="form" class="admin-form">
            <label>Username<input data-bind="username" autocomplete="username" value="${escapeHtml(ctx.user.username || "")}"></label>
            <label>Password<input data-bind="password" type="password" autocomplete="current-password"></label>
            <button class="primary" type="submit">Unlock admin tools</button>
          </form>
          <div class="admin-error" data-bind="error"></div>
        </div>
      </div>
      <div class="admin-shell hidden" data-bind="shell">
        <div class="admin-tabs">
          ${TABS.map((tab) => `<button data-tab="${tab}">${label(tab)}</button>`).join("")}
        </div>
        <div class="admin-body" data-bind="body"></div>
      </div>
    </div>
  `;

  const gate = root.querySelector('[data-bind="gate"]');
  const shell = root.querySelector('[data-bind="shell"]');
  const body = root.querySelector('[data-bind="body"]');
  const err = root.querySelector('[data-bind="error"]');
  let wordlistUnsub = null;

  root.querySelector('[data-bind="form"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    err.textContent = "";
    const username = root.querySelector('[data-bind="username"]').value.trim();
    const password = root.querySelector('[data-bind="password"]').value;
    try {
      await reauthenticateBlizzardUser(username, password);
      await requireRole(ctx.user.uid, "admin");
      gate.classList.add("hidden");
      shell.classList.remove("hidden");
      switchTab("reports");
    } catch (e) {
      err.textContent = e.message || "Admin unlock failed.";
    }
  });

  root.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  async function switchTab(tab) {
    root.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
    if (wordlistUnsub) { wordlistUnsub(); wordlistUnsub = null; }
    if (tab === "reports") await renderReports();
    if (tab === "users") await renderUsers();
    if (tab === "audit") await renderAudit();
    if (tab === "settings") renderSettings();
  }

  async function renderReports() {
    const reports = await listReports();
    body.innerHTML = `
      <div class="admin-toolbar">
        <button data-filter="open" class="active">Open</button>
        <button data-filter="dismissed">Dismissed</button>
        <button data-filter="actioned">Actioned</button>
        <button data-filter="all">All</button>
        <span class="spacer"></span>
        <button data-act="refresh">Refresh</button>
      </div>
      <div data-bind="reports"></div>
    `;
    let filter = "open";
    const list = body.querySelector('[data-bind="reports"]');
    const paint = () => {
      const rows = reports.filter((report) => filter === "all" || (report.status || "open") === filter);
      list.innerHTML = rows.length ? rows.map((report) => `
        <div class="admin-row">
          <div>
            <div><b>${escapeHtml(report.domain || "unknown target")}</b> <span class="pill">${escapeHtml(report.status || "open")}</span></div>
            <div class="muted">Reported by @${escapeHtml(report.reporterUsername || "anon")} at ${new Date(report.ts || 0).toLocaleString()}</div>
            <div class="admin-reason">${escapeHtml(report.reason || "")}</div>
          </div>
          <div class="admin-actions">
            <button data-act="warn" data-reporter="${escapeHtml(report.reporterUid || "")}">Warn reporter</button>
            <button data-act="actioned" data-id="${escapeHtml(report.id)}">Mark actioned</button>
            <button data-act="dismiss" data-id="${escapeHtml(report.id)}">Dismiss</button>
          </div>
        </div>
      `).join("") : `<div class="muted admin-empty">No reports here.</div>`;
      list.querySelectorAll('[data-act="dismiss"]').forEach((button) => button.onclick = async () => {
        await setReportStatusByAdmin(ctx.user.uid, button.dataset.id, "dismissed");
        await renderReports();
      });
      list.querySelectorAll('[data-act="actioned"]').forEach((button) => button.onclick = async () => {
        await setReportStatusByAdmin(ctx.user.uid, button.dataset.id, "actioned");
        await renderReports();
      });
      list.querySelectorAll('[data-act="warn"]').forEach((button) => button.onclick = async () => {
        const text = prompt("Warning text?");
        if (text) await issueWarning(ctx.user.uid, button.dataset.reporter, text, "Report review");
      });
    };
    body.querySelectorAll("[data-filter]").forEach((button) => button.onclick = () => {
      filter = button.dataset.filter;
      body.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("active", b === button));
      paint();
    });
    body.querySelector('[data-act="refresh"]').onclick = renderReports;
    paint();
  }

  async function renderUsers() {
    body.innerHTML = `
      <div class="admin-toolbar">
        <input data-bind="q" placeholder="Search username">
        <button class="primary" data-act="search">Search</button>
        <button data-act="all">Show recent users</button>
      </div>
      <div data-bind="users"></div>
    `;
    const list = body.querySelector('[data-bind="users"]');
    const show = async (users) => {
      list.innerHTML = users.length ? users.map(userCard).join("") : `<div class="muted admin-empty">No users found.</div>`;
      wireUserActions(list);
    };
    body.querySelector('[data-act="all"]').onclick = async () => show(await listUsers(100));
    body.querySelector('[data-act="search"]').onclick = async () => {
      const name = body.querySelector('[data-bind="q"]').value.trim();
      if (!name) return;
      const uid = await lookupUidByUsername(name);
      show(uid ? [{ uid, ...(await loadUser(uid)) }] : []);
    };
    await show(await listUsers(50));
  }

  function userCard(user) {
    const av = avatarHtml(user);
    const warnings = Object.keys(user.warnings || {}).length;
    const timeoutActive = user.timeout?.until && user.timeout.until > Date.now();
    return `
      <div class="admin-row" data-uid="${escapeHtml(user.uid)}" data-username="${escapeHtml(user.username || "")}" data-quota="${escapeHtml(user.quota_tier || "free")}">
        <div class="admin-user-head">
          <div class="admin-avatar" style="${av.style}">${escapeHtml(av.text)}</div>
          <div>
            <div><b>@${escapeHtml(user.username || "unknown")}</b> <span class="pill">${escapeHtml(user.role || "user")}</span>${user.banned ? ' <span class="pill">banned</span>' : ""}${timeoutActive ? ' <span class="pill">timeout</span>' : ""}</div>
            <div class="muted">${warnings} warning${warnings === 1 ? "" : "s"} · storage ${escapeHtml(user.quota_tier || "free")}${user.createdAt ? " - joined " + new Date(user.createdAt).toLocaleDateString() : ""}</div>
          </div>
        </div>
        <div class="admin-actions">
          <button data-act="role">Role</button>
          <button data-act="quota">${user.quota_tier === "trusted" ? "Free quota" : "Trusted quota"}</button>
          <button data-act="warn">Warn</button>
          <button data-act="timeout">Timeout</button>
          <button data-act="appban">App ban</button>
          <button data-act="wipe" title="Delete every message this user has sent across channels, DMs, server channels, BlizzTube comments, and stream chats">Wipe messages</button>
          <button class="danger" data-act="globalban">Global ban</button>
        </div>
      </div>
    `;
  }

  function wireUserActions(scope) {
    scope.querySelectorAll(".admin-row[data-uid]").forEach((row) => {
      const uid = row.dataset.uid;
      const username = row.dataset.username;
      row.querySelector('[data-act="role"]').onclick = async () => {
        const role = prompt("Role: user, mod, or admin", "user");
        if (!role) return;
        await setUserRoleByAdmin(ctx.user.uid, uid, role.trim(), "Role changed in Admin Console");
        await renderUsers();
      };
      row.querySelector('[data-act="quota"]').onclick = async () => {
        const next = row.dataset.quota === "trusted" ? "free" : "trusted";
        const reason = prompt(`Reason for setting @${username} quota to ${next}`, "Storage grant");
        if (!reason) return;
        await setQuotaTierByAdmin(ctx.user.uid, uid, next, reason);
        await renderUsers();
      };
      row.querySelector('[data-act="warn"]').onclick = async () => {
        const text = prompt(`Warning for @${username}`);
        if (!text) return;
        await issueWarning(ctx.user.uid, uid, text, "Admin warning");
      };
      row.querySelector('[data-act="timeout"]').onclick = async () => {
        const minutes = Number(prompt("Timeout minutes", "60"));
        if (!Number.isFinite(minutes) || minutes <= 0) return;
        const reason = prompt("Reason", "Moderation timeout") || "Moderation timeout";
        await setUserTimeoutByAdmin(ctx.user.uid, uid, Date.now() + minutes * 60 * 1000, reason);
        await renderUsers();
      };
      row.querySelector('[data-act="appban"]').onclick = async () => {
        const app = prompt("App id to ban/unban (tube, tunes, messenger, livestream, etc.)", "tunes");
        if (!app) return;
        const banned = confirm(`OK = ban @${username} from ${app}. Cancel = unban.`);
        await setAppBanByAdmin(ctx.user.uid, uid, app.trim(), banned, "App moderation");
      };
      row.querySelector('[data-act="wipe"]').onclick = async () => {
        const reason = prompt(`Wipe ALL messages by @${username}? Type a reason to continue.`);
        if (!reason || !reason.trim()) return;
        const btn = row.querySelector('[data-act="wipe"]');
        btn.disabled = true;
        const orig = btn.textContent;
        btn.textContent = "Wiping...";
        try {
          const deleted = await adminBulkDeleteUserMessages(ctx.user.uid, uid, reason.trim());
          btn.textContent = `Wiped ${deleted}`;
          alert(`Deleted ${deleted} message(s) by @${username}.`);
        } catch (e) {
          alert("Wipe failed: " + e.message);
        } finally {
          setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 2500);
        }
      };
      row.querySelector('[data-act="globalban"]').onclick = async () => {
        const typed = prompt(`Type username to globally ban @${username}`);
        if (typed !== username) return;
        const reason = prompt("Typed reason required");
        if (!reason) return;
        row.querySelector('[data-act="globalban"]').disabled = true;
        row.querySelector('[data-act="globalban"]').textContent = "Waiting 5s...";
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await globalBanUser(ctx.user.uid, uid, typed, reason);
        await renderUsers();
      };
    });
  }

  async function renderAudit() {
    const rows = await listAuditLog("admin_audit_log");
    body.innerHTML = rows.length ? rows.map((row) => `
      <div class="admin-row">
        <div>
          <div><b>${escapeHtml(row.action)}</b> <span class="muted">${new Date(row.ts || 0).toLocaleString()}</span></div>
          <div class="muted">admin ${escapeHtml(row.actorUid || "")} -> target ${escapeHtml(row.targetUid || "")}</div>
          <div class="admin-reason">${escapeHtml(row.reason || "")}</div>
        </div>
      </div>
    `).join("") : `<div class="muted admin-empty">No audit entries yet.</div>`;
  }

  function renderSettings() {
    body.innerHTML = `
      <div class="admin-row">
        <div style="width:100%">
          <h3>Auto-moderation word lists</h3>
          <textarea data-bind="wordlists" class="admin-json"></textarea>
          <div class="admin-actions">
            <button class="primary" data-act="save">Save word lists</button>
            <button data-act="mod">Open mod queue</button>
          </div>
          <div class="muted">Admins can bootstrap the first admin by setting <code>users/&lt;uid&gt;/role = "admin"</code> once in Firebase.</div>
        </div>
      </div>
    `;
    const area = body.querySelector('[data-bind="wordlists"]');
    wordlistUnsub = subscribeModerationWordlists((lists) => {
      area.value = JSON.stringify(lists, null, 2);
    });
    body.querySelector('[data-act="save"]').onclick = async () => {
      try {
        await saveModerationWordlists(ctx.user.uid, JSON.parse(area.value));
        alert("Moderation settings saved.");
      } catch (e) {
        alert("Could not save: " + e.message);
      }
    };
    body.querySelector('[data-act="mod"]').onclick = () => ctx.launchApp?.("mod");
  }
}

function label(tab) {
  return tab[0].toUpperCase() + tab.slice(1);
}
