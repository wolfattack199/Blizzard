// blizz://reports — anyone with the URL can view & manage site reports.
// (No special admin: this is a small community OS. In a real product you'd
// gate this on an admin role; here we trust authenticated users.)
import { listReports, setReportStatus, listSites, reportSite } from "../firebase.js";
import { escapeHtml } from "../os/wm.js";

export async function renderReportsPage(host, ctx, navigate) {
  host.innerHTML = `
    <div class="browser-home" style="text-align:left;max-width:900px;margin:0 auto;user-select:text">
      <div style="text-align:center">
        <div class="browser-home-title" style="font-size:36px">Site reports</div>
        <div class="browser-home-sub">Sites the community has flagged for review.</div>
      </div>
      <div data-bind="list" style="margin-top:20px"></div>
    </div>
  `;
  const list = host.querySelector('[data-bind="list"]');
  await refresh();

  async function refresh() {
    const [reports, sites] = await Promise.all([listReports(), listSites()]);
    if (reports.length === 0) {
      list.innerHTML = `<div class="muted" style="padding:30px;text-align:center">No reports yet.</div>`;
      return;
    }
    list.innerHTML = reports.map((r) => {
      const site = sites.find((s) => s.domain === r.domain);
      return `
        <div style="background:var(--bg-2);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;color:var(--accent-2);font-size:14px">blizz://${escapeHtml(r.domain)}</div>
              <div class="muted" style="font-size:11.5px">reported by @${escapeHtml(r.reporterUsername || "?")} · ${new Date(r.ts || 0).toLocaleString()}</div>
              <div style="margin-top:6px;color:var(--text-0);white-space:pre-wrap">${escapeHtml(r.reason || "")}</div>
              ${site ? `<div class="muted" style="font-size:12px;margin-top:6px">Site description: ${escapeHtml(site.description || "—")}</div>` : `<div class="muted" style="font-size:12px;margin-top:6px">Site no longer exists.</div>`}
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0">
              <span style="background:${statusColor(r.status)};color:#06122a;font-size:10px;padding:2px 8px;border-radius:3px;font-weight:700;letter-spacing:0.4px;text-align:center">${escapeHtml(r.status || "open")}</span>
              <button data-act="visit" data-domain="${escapeHtml(r.domain)}" style="font-size:11.5px">Visit site</button>
              ${r.status !== "resolved" ? `<button data-act="resolve" data-id="${escapeHtml(r.id)}" style="font-size:11.5px">Mark resolved</button>` : ""}
              ${r.status !== "dismissed" ? `<button data-act="dismiss" data-id="${escapeHtml(r.id)}" style="font-size:11.5px">Dismiss</button>` : ""}
            </div>
          </div>
        </div>
      `;
    }).join("");

    list.querySelectorAll('[data-act="visit"]').forEach((b) =>
      b.addEventListener("click", () => navigate(b.dataset.domain))
    );
    list.querySelectorAll('[data-act="resolve"]').forEach((b) =>
      b.addEventListener("click", async () => { await setReportStatus(b.dataset.id, "resolved"); refresh(); })
    );
    list.querySelectorAll('[data-act="dismiss"]').forEach((b) =>
      b.addEventListener("click", async () => { await setReportStatus(b.dataset.id, "dismissed"); refresh(); })
    );
  }
}

function statusColor(s) {
  if (s === "resolved")  return "#5bd6a4";
  if (s === "dismissed") return "#7c8ba8";
  return "#ffd66e";
}

// Open the report-this-site dialog. Used from the browser's Report button.
export function openReportDialog(domain, ctx) {
  const overlay = document.createElement("div");
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(5,9,18,0.7);z-index:6500;display:flex;align-items:center;justify-content:center`;
  overlay.innerHTML = `
    <div style="width:460px;background:var(--bg-1);border:1px solid var(--line-strong);border-radius:10px;padding:18px;box-shadow:var(--shadow-2);user-select:text">
      <h3 style="margin:0 0 8px;font-weight:500">Report site</h3>
      <div class="muted" style="font-size:12px;margin-bottom:12px">Reporting blizz://${escapeHtml(domain)}</div>
      <textarea id="rp-reason" rows="4" placeholder="Why are you reporting this site?"
        style="width:100%;padding:8px 10px;background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:5px;color:var(--text-0);outline:none;resize:vertical;font-family:inherit"></textarea>
      <div class="row" style="justify-content:flex-end;margin-top:12px;gap:8px">
        <button id="rp-cancel">Cancel</button>
        <button class="danger" id="rp-submit">Submit report</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector("#rp-cancel").onclick = () => overlay.remove();
  overlay.querySelector("#rp-submit").onclick = async () => {
    const reason = overlay.querySelector("#rp-reason").value.trim();
    if (!reason) { alert("Please describe the issue."); return; }
    await reportSite(domain, ctx.user.uid, ctx.user.username, reason);
    overlay.remove();
    alert("Report submitted. View all reports at blizz://reports.blz");
  };
}
