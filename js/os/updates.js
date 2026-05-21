// Update hub: checks GitHub for a newer commit on the main branch and pops a
// toast inviting the user to update. The "current" SHA below is stamped at
// commit time — when pushing a new version, refresh it via:
//   git rev-parse HEAD > tmp && powershell -Command "(Get-Content js/os/updates.js) -replace 'LOCAL_BUILD_SHA = \"[^\"]+\"', ('LOCAL_BUILD_SHA = \"' + (Get-Content tmp) + '\"') | Set-Content js/os/updates.js"
// or just edit the constant by hand.
import { showToast } from "./toasts.js";

const REPO          = "wolfattack199/Blizzard";
const BRANCH        = "main";
const LOCAL_BUILD_SHA = "25e79e8";
const REPO_URL      = `https://github.com/${REPO}`;
const SUPPRESS_KEY  = "blizzard.suppressUpdateSha";
const CHECK_DELAY   = 6000;    // wait until after boot animations
const RECHECK_EVERY = 30 * 60 * 1000;

export function startUpdateChecker() {
  setTimeout(checkOnce, CHECK_DELAY);
  setInterval(checkOnce, RECHECK_EVERY);
}

async function checkOnce() {
  if (!navigator.onLine) return;
  let remoteSha;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
      headers: { "Accept": "application/vnd.github+json" }
    });
    if (!res.ok) return;
    const json = await res.json();
    remoteSha = json?.sha;
  } catch { return; }
  // Allow the local SHA to be a short prefix (e.g. "25e79e8") of the full
  // 40-char GitHub SHA — saves having to look up the full hash by hand.
  if (!remoteSha) return;
  if (remoteSha === LOCAL_BUILD_SHA) return;
  if (LOCAL_BUILD_SHA && remoteSha.startsWith(LOCAL_BUILD_SHA)) return;
  // Don't pester the user — if they dismissed an update toast for this exact SHA, stay silent.
  if (localStorage.getItem(SUPPRESS_KEY) === remoteSha) return;
  showUpdateToast(remoteSha);
}

function showUpdateToast(remoteSha) {
  showToast({
    title: "You have an outdated version",
    body: "Blizzard has a newer build on GitHub. Click here to update.",
    context: "Update hub",
    glyph: "⬆",
    duration: 30000,
    onClick: () => openUpdateInstructions(remoteSha)
  });
}

function openUpdateInstructions(remoteSha) {
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(5,9,18,0.7);z-index:9000;display:flex;align-items:center;justify-content:center";
  overlay.innerHTML = `
    <div style="width:520px;max-width:92vw;background:var(--bg-1);border:1px solid var(--line-strong);border-radius:10px;padding:22px;box-shadow:var(--shadow-2);user-select:text;color:var(--text-0)">
      <h2 style="margin:0 0 10px;font-weight:500">Update Blizzard</h2>
      <p class="muted" style="font-size:13px;margin:0 0 14px">
        A newer commit is available on
        <a href="${REPO_URL}" target="_blank" rel="noopener" style="color:var(--accent-2)">${REPO_URL}</a>.
      </p>
      <div style="background:rgba(0,0,0,0.3);border:1px solid var(--line);border-radius:6px;padding:10px;font-family:var(--mono);font-size:12px;line-height:1.5;color:var(--text-1);user-select:text">
        <div># In the folder where Blizzard is checked out:</div>
        <div style="color:var(--accent-2)">git pull</div>
        <div style="margin-top:6px"># Or, fresh download:</div>
        <div style="color:var(--accent-2)">git clone https://github.com/${REPO}.git</div>
        <div style="margin-top:6px"># Then reload the page.</div>
      </div>
      <div class="muted" style="font-size:11px;margin-top:10px">
        Current build · <span style="font-family:var(--mono)">${LOCAL_BUILD_SHA.slice(0, 7)}</span>
        &nbsp; → &nbsp; Latest · <span style="font-family:var(--mono)">${remoteSha.slice(0, 7)}</span>
      </div>
      <div class="row" style="justify-content:flex-end;gap:8px;margin-top:16px">
        <button data-act="snooze">Hide for this version</button>
        <a href="${REPO_URL}" target="_blank" rel="noopener" style="text-decoration:none">
          <button class="primary">Open GitHub</button>
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('[data-act="snooze"]').addEventListener("click", () => {
    localStorage.setItem(SUPPRESS_KEY, remoteSha);
    overlay.remove();
  });
}
