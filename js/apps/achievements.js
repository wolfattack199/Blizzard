import { loadUser } from "../firebase.js";
import { getAchievementsCatalog } from "../achievements.js";
import { escapeHtml } from "../os/wm.js";

export async function mountAchievements(root, ctx) {
  await renderAchievementsPage(root, ctx);
}

export async function renderAchievementsPage(root, ctx) {
  root.innerHTML = `
    <div class="app achievements-app">
      <div class="app-toolbar">
        <button data-filter="all" class="active">All</button>
        <button data-filter="unlocked">Unlocked</button>
        <button data-filter="locked">Locked</button>
        <button data-filter="bronze">Bronze</button>
        <button data-filter="silver">Silver</button>
        <button data-filter="gold">Gold</button>
        <button data-filter="platinum">Platinum</button>
        <span class="grow"></span>
        <span class="muted" data-bind="summary"></span>
      </div>
      <div class="achievements-list" data-bind="list">Loading...</div>
    </div>
  `;

  const [catalog, user] = await Promise.all([
    getAchievementsCatalog(),
    loadUser(ctx.user.uid)
  ]);
  const achievements = Object.values(catalog || {});
  const unlocked = user?.achievements || {};
  const list = root.querySelector('[data-bind="list"]');
  const summary = root.querySelector('[data-bind="summary"]');
  let filter = "all";

  function paint() {
    const rows = achievements.filter((a) => {
      const has = !!unlocked[a.id];
      if (filter === "unlocked") return has;
      if (filter === "locked") return !has;
      if (["bronze", "silver", "gold", "platinum"].includes(filter)) return a.tier === filter;
      return true;
    });
    const count = achievements.filter((a) => unlocked[a.id]).length;
    summary.textContent = `${Number(user?.points) || 0} points · ${count} of ${achievements.length} unlocked`;
    list.innerHTML = rows.map((a) => {
      const has = unlocked[a.id];
      const when = has?.unlockedAt ? new Date(has.unlockedAt).toLocaleString() : "";
      return `
        <div class="achievement-row ${has ? "" : "locked"} tier-${escapeHtml(a.tier || "bronze")}">
          <div class="achievement-row-glyph">${escapeHtml(a.glyph || "*")}</div>
          <div>
            <div><b>${escapeHtml(a.name)}</b> <span class="pill">${escapeHtml(a.tier || "bronze")}</span> <span class="muted">+${Number(a.points) || 0}</span></div>
            <div class="muted">${escapeHtml(a.description || "")}</div>
            <div class="muted" style="font-size:11px">${has ? "Unlocked " + escapeHtml(when) : "How to unlock: " + escapeHtml(unlockHint(a))}</div>
          </div>
        </div>
      `;
    }).join("") || `<div class="muted" style="padding:20px">No achievements match that filter.</div>`;
  }

  root.querySelectorAll("[data-filter]").forEach((button) => {
    button.onclick = () => {
      filter = button.dataset.filter;
      root.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("active", b === button));
      paint();
    };
  });
  paint();
}

function unlockHint(a) {
  const trigger = a.trigger || {};
  if (trigger.type === "counter") {
    return `${String(trigger.key || "").replace(/_/g, " ")} ${trigger.threshold || 1} time${trigger.threshold === 1 ? "" : "s"}`;
  }
  return a.description || "Keep using Blizzard";
}
