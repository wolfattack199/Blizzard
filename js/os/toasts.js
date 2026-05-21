// OS-wide toast notifications (mentions, go-live, etc.).
// Stacks bottom-right above the taskbar, auto-dismisses after ~10s,
// pauses while hovered, slides out on dismiss.
import { escapeHtml } from "./wm.js";
import { avatarHtml } from "./avatar.js";

const MAX_STACK = 3;
let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = document.createElement("div");
  container.className = "toast-stack";
  document.body.appendChild(container);
  return container;
}

/**
 * Show a toast.
 * @param {Object} opts
 * @param {string} opts.title           Bold first line (e.g., the sender's @name).
 * @param {string} opts.body            Preview line (the message text).
 * @param {string} [opts.context]       Small grey line ("in #general", "DM").
 * @param {{username, uid, avatarUrl}} [opts.user]  Used to render the avatar.
 * @param {string} [opts.glyph]         Replaces avatar with a single emoji.
 * @param {number} [opts.duration]      ms, default 10000.
 * @param {Function} [opts.onClick]     Called when the user clicks the toast body.
 */
export function showToast(opts) {
  const stack = ensureContainer();
  while (stack.children.length >= MAX_STACK) stack.firstElementChild?.remove();

  const node = document.createElement("div");
  node.className = "toast";
  const av = opts.user ? avatarHtml(opts.user) : null;
  node.innerHTML = `
    <div class="toast-avatar"${av ? ` style="${av.style}"` : ` style="background:linear-gradient(135deg, var(--accent), var(--accent-2));color:#06122a"`}>
      ${opts.glyph ? escapeHtml(opts.glyph) : (av ? escapeHtml(av.text) : "🔔")}
    </div>
    <div class="toast-body">
      <div class="toast-title">${escapeHtml(opts.title || "")}</div>
      ${opts.body    ? `<div class="toast-text">${escapeHtml(opts.body)}</div>` : ""}
      ${opts.context ? `<div class="toast-context">${escapeHtml(opts.context)}</div>` : ""}
    </div>
    <button class="toast-close" title="Dismiss">×</button>
  `;
  stack.appendChild(node);

  // Slide-in
  requestAnimationFrame(() => node.classList.add("toast-in"));

  let remaining = Math.max(2000, opts.duration ?? 10000);
  let lastStart = Date.now();
  let timer = null;
  const dismiss = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    node.classList.remove("toast-in");
    node.classList.add("toast-out");
    setTimeout(() => node.remove(), 220);
  };
  const startTimer = () => {
    lastStart = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  startTimer();

  node.addEventListener("mouseenter", () => {
    if (timer) {
      clearTimeout(timer);
      remaining -= (Date.now() - lastStart);
      timer = null;
    }
  });
  node.addEventListener("mouseleave", () => {
    if (!timer && remaining > 200) startTimer();
  });
  node.querySelector(".toast-close").addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
  });
  if (opts.onClick) {
    node.querySelector(".toast-body").addEventListener("click", () => {
      try { opts.onClick(); } catch {}
      dismiss();
    });
  }
}
