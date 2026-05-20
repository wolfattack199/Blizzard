// Shared avatar rendering.
//   renderAvatar(el, user, opts) — set background or image on the given element.
//   user = { uid, username, profile? } OR { uid, username, avatarUrl }
import { escapeHtml } from "./wm.js";

const COLORS = ["#5aa9ff", "#7cc7ff", "#ff6b7a", "#ffd66e", "#5bd6a4", "#bdb2ff", "#ffafcc", "#fdffb6"];

export function avatarColor(uid) {
  let h = 0;
  for (const c of String(uid || "x")) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function avatarUrlFor(user) {
  return user?.profile?.avatarUrl || user?.avatarUrl || "";
}

// Returns an inline-style + content snippet you can drop into an avatar div.
export function avatarHtml(user) {
  const url = avatarUrlFor(user);
  const letter = (user?.username || "?")[0].toUpperCase();
  if (url) {
    return {
      style: `background-image:url("${escapeCss(url)}");background-size:cover;background-position:center;color:transparent`,
      text: ""
    };
  }
  return {
    style: `background:${avatarColor(user?.uid)}`,
    text: letter
  };
}

// Resize an image File via canvas, return a base64 data URL. Used for uploads.
export function resizeImageToDataURL(file, maxDim = 192, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = reject;
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const cx = c.getContext("2d");
        cx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

function escapeCss(s) { return String(s).replace(/"/g, '\\"'); }
