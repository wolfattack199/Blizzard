// Profiles — browse users, view their profile + published sites, edit own bio + avatar.
import { listUsers, loadUser, listSites, updateProfile } from "../firebase.js";
import { getAchievementsCatalog } from "../achievements.js";
import { escapeHtml } from "../os/wm.js";
import { avatarHtml, resizeImageToDataURL, avatarColor as colorFor } from "../os/avatar.js";

export async function mountProfiles(root, ctx) {
  root.innerHTML = `
    <div class="app">
      <div class="profiles">
        <div class="profiles-list" data-bind="list"></div>
        <div class="profiles-detail" data-bind="detail">
          <div class="muted">Select a user to view their profile.</div>
        </div>
      </div>
    </div>
  `;

  const listEl = root.querySelector('[data-bind="list"]');
  const detail = root.querySelector('[data-bind="detail"]');

  const [users, allSites] = await Promise.all([listUsers(), listSites()]);
  // Put current user first
  users.sort((a, b) => (a.uid === ctx.user.uid ? -1 : b.uid === ctx.user.uid ? 1 : (a.username || "").localeCompare(b.username || "")));

  listEl.innerHTML = users.map((u) => {
    const av = avatarHtml(u);
    return `
    <div class="profile-row" data-uid="${escapeHtml(u.uid)}">
      <div class="profile-avatar" style="${av.style}">${escapeHtml(av.text)}</div>
      <div style="min-width:0;flex:1">
        <div class="profile-row-name">@${escapeHtml(u.username || "anon")}${u.uid === ctx.user.uid ? ' <span class="pill">you</span>' : ""}</div>
        <div class="profile-row-bio">${escapeHtml(u.profile?.bio || "—")}</div>
      </div>
    </div>
  `;}).join("");

  listEl.querySelectorAll(".profile-row").forEach((row) =>
    row.addEventListener("click", () => {
      listEl.querySelectorAll(".profile-row").forEach((r) => r.classList.toggle("active", r === row));
      renderProfile(row.dataset.uid);
    })
  );

  async function renderProfile(uid) {
    const u = await loadUser(uid);
    if (!u) { detail.innerHTML = `<div class="muted">User not found.</div>`; return; }
    const sites = allSites.filter((s) => s.owner === uid);
    const isMe = uid === ctx.user.uid;
    const av = avatarHtml(u);
    const catalog = await getAchievementsCatalog();
    const achievementsHtml = renderAchievements(u, catalog, isMe);

    detail.innerHTML = `
      <div class="profiles-detail-header">
        <div class="profile-avatar" style="${av.style}">${escapeHtml(av.text)}</div>
        <div>
          <h2>@${escapeHtml(u.username || "anon")}</h2>
          <div class="muted">Joined ${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}</div>
          ${isMe ? `
            <input type="file" accept="image/*" data-bind="av-upload" style="display:none">
            <div style="margin-top:6px;display:flex;gap:6px;align-items:center">
              <button data-act="av-pick" style="padding:3px 9px;font-size:11.5px">Change picture</button>
              <button data-act="av-remove" style="padding:3px 9px;font-size:11.5px${u.profile?.avatarUrl ? "" : ";display:none"}">Remove</button>
            </div>
          ` : ""}
        </div>
      </div>

      ${isMe ? `
        <div>
          <label class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Bio</label>
          <textarea data-bind="bio" rows="3"
            style="display:block;width:100%;margin-top:6px;padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:6px;color:var(--text-0);outline:none;resize:vertical;font-family:inherit">${escapeHtml(u.profile?.bio || "")}</textarea>
          <button class="primary" data-act="save-bio" style="margin-top:8px">Save bio</button>
          <span class="muted" data-bind="bio-status" style="margin-left:10px;font-size:12px"></span>
        </div>
      ` : `
        <div>
          <label class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Bio</label>
          <div style="margin-top:6px;white-space:pre-wrap">${escapeHtml(u.profile?.bio || "(no bio yet)")}</div>
          <div style="margin-top:14px"><button data-act="dm">Message @${escapeHtml(u.username)}</button></div>
        </div>
      `}

      ${achievementsHtml}

      <div class="sites-block">
        <label class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Published sites</label>
        ${sites.length === 0
          ? `<div class="muted" style="padding:10px 0">${isMe ? "You haven't" : "@" + escapeHtml(u.username) + " hasn't"} published anything yet.</div>`
          : sites.map((s) => `
              <div class="profile-site" data-domain="${escapeHtml(s.domain)}">
                <div style="font-weight:600;color:var(--accent-2)">blizz://${escapeHtml(s.domain)}</div>
                <div class="muted" style="font-size:12px">${escapeHtml(s.description || "—")}</div>
              </div>
            `).join("")}
      </div>
    `;

    if (isMe) {
      const status = detail.querySelector('[data-bind="bio-status"]');
      detail.querySelector('[data-act="save-bio"]').onclick = async () => {
        const text = detail.querySelector('[data-bind="bio"]').value.trim();
        await updateProfile(ctx.user.uid, { bio: text });
        status.textContent = "Saved ✓";
        setTimeout(() => { status.textContent = ""; }, 1500);
      };
      const upload = detail.querySelector('[data-bind="av-upload"]');
      const pickBtn = detail.querySelector('[data-act="av-pick"]');
      if (pickBtn && upload) pickBtn.onclick = () => upload.click();
      if (upload) upload.onchange = async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        try {
          const dataUrl = await resizeImageToDataURL(f, 192, 0.85);
          await updateProfile(ctx.user.uid, { avatarUrl: dataUrl, bio: u.profile?.bio || "" });
          // Reflect on the live user context for other apps
          if (!ctx.user.profile) ctx.user.profile = {};
          ctx.user.profile.avatarUrl = dataUrl;
          document.dispatchEvent(new CustomEvent("blizzard:profile-changed"));
          // Refresh both list + this view
          const users2 = await listUsers();
          const i = users.findIndex((x) => x.uid === ctx.user.uid);
          if (i >= 0) users[i] = users2.find((x) => x.uid === ctx.user.uid) || users[i];
          // Re-render this profile
          renderProfile(ctx.user.uid);
          // Re-render sidebar row
          const row = listEl.querySelector(`[data-uid="${ctx.user.uid}"] .profile-avatar`);
          if (row) {
            const a2 = avatarHtml(users[i]);
            row.style.cssText = a2.style;
            row.textContent = a2.text;
          }
        } catch (err) { alert("Upload failed: " + err.message); }
      };
      const removeBtn = detail.querySelector('[data-act="av-remove"]');
      if (removeBtn) removeBtn.onclick = async () => {
        await updateProfile(ctx.user.uid, { avatarUrl: "" });
        if (ctx.user.profile) ctx.user.profile.avatarUrl = "";
        document.dispatchEvent(new CustomEvent("blizzard:profile-changed"));
        renderProfile(ctx.user.uid);
      };
    } else {
      detail.querySelector('[data-act="dm"]').onclick = () => ctx.launchApp("messenger");
    }
    detail.querySelectorAll(".profile-site").forEach((s) =>
      s.addEventListener("click", () => {
        ctx.launchApp("browser");
        // best-effort: ask the browser to navigate to this domain
        const ev = new CustomEvent("blizzard:navigate", { detail: { domain: s.dataset.domain } });
        document.dispatchEvent(ev);
      })
    );
  }

  // Auto-select current user
  const me = listEl.querySelector(`[data-uid="${ctx.user.uid}"]`);
  if (me) { me.classList.add("active"); renderProfile(ctx.user.uid); }
}

function renderAchievements(user, catalog, isMe) {
  const all = Object.values(catalog || {});
  const unlocked = user.achievements || {};
  const hideLocked = user.profile?.hideAchievementProgress && !isMe;
  const visible = hideLocked ? all.filter((a) => unlocked[a.id]) : all;
  const unlockedCount = all.filter((a) => unlocked[a.id]).length;
  return `
    <div class="profile-achievements">
      <div class="profile-achievements-head">
        <label class="muted">Achievements</label>
        <span>${Number(user.points) || 0} points · ${unlockedCount} of ${all.length}</span>
      </div>
      <div class="profile-achievement-grid">
        ${visible.map((a) => {
          const row = unlocked[a.id];
          const when = row?.unlockedAt ? new Date(row.unlockedAt).toLocaleDateString() : "";
          const title = row
            ? `${a.name} - ${a.description}${when ? " - unlocked " + when : ""}`
            : `${a.name} - How to unlock: ${unlockHint(a)}`;
          return `
            <div class="profile-achievement ${row ? "" : "locked"} tier-${escapeHtml(a.tier || "bronze")}" title="${escapeHtml(title)}">
              <div class="profile-achievement-glyph">${escapeHtml(a.glyph || "*")}</div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function unlockHint(a) {
  const trigger = a.trigger || {};
  if (trigger.type === "counter") {
    return `${prettyCounter(trigger.key)} ${trigger.threshold || 1} time${trigger.threshold === 1 ? "" : "s"}`;
  }
  return a.description || "Keep using Blizzard";
}

function prettyCounter(key = "") {
  return String(key).replace(/_/g, " ");
}
