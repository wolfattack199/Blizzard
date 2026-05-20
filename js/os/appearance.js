// Appearance / theming. Stored per-user in localStorage and applied to <html>.

const KEY_BASE = "blizzard.appearance.";

export const APPEARANCE_PRESETS = [
  {
    name: "Aurora",
    thumb: "linear-gradient(135deg, #0b1220, #18254a, #5aa9ff)",
    bg: `radial-gradient(circle at 25% 25%, rgba(90, 169, 255, 0.18), transparent 35%),
         radial-gradient(circle at 75% 75%, rgba(124, 199, 255, 0.12), transparent 40%),
         linear-gradient(135deg, #0b1220 0%, #18254a 50%, #0b1220 100%)`
  },
  {
    name: "Sunset",
    thumb: "linear-gradient(135deg, #2b1d3a, #ff6b7a, #ffd66e)",
    bg: `radial-gradient(circle at 20% 30%, rgba(255, 107, 122, 0.25), transparent 40%),
         radial-gradient(circle at 80% 70%, rgba(255, 214, 110, 0.18), transparent 45%),
         linear-gradient(135deg, #2b1d3a, #4a1f3a 50%, #2b1d3a)`
  },
  {
    name: "Forest",
    thumb: "linear-gradient(135deg, #0a1f1a, #5bd6a4)",
    bg: `radial-gradient(circle at 30% 30%, rgba(91, 214, 164, 0.18), transparent 40%),
         linear-gradient(135deg, #0a1f1a, #133b2e 50%, #0a1f1a)`
  },
  {
    name: "Plum",
    thumb: "linear-gradient(135deg, #1a0f2e, #bdb2ff)",
    bg: `radial-gradient(circle at 20% 80%, rgba(189, 178, 255, 0.22), transparent 45%),
         linear-gradient(135deg, #1a0f2e, #2b1a4a 50%, #1a0f2e)`
  },
  {
    name: "Slate",
    thumb: "linear-gradient(135deg, #1a1a1a, #4a4a4a)",
    bg: `linear-gradient(135deg, #1a1a1a, #2a2a2a 50%, #1a1a1a)`
  },
  {
    name: "Ice",
    thumb: "linear-gradient(135deg, #d6efff, #7cc7ff)",
    bg: `radial-gradient(circle at 25% 25%, rgba(255, 255, 255, 0.18), transparent 40%),
         linear-gradient(135deg, #b4dcff, #7cc7ff 50%, #b4dcff)`
  }
];

let currentUid = "guest";
export function setAppearanceUser(uid) {
  currentUid = uid || "guest";
}

function storageKey() { return KEY_BASE + currentUid; }

const DEFAULT = { kind: "preset", preset: 0, solid: "#0b1220", imageUrl: "", accent: "#5aa9ff" };

export function getAppearance() {
  try {
    return { ...DEFAULT, ...JSON.parse(localStorage.getItem(storageKey()) || "{}") };
  } catch { return { ...DEFAULT }; }
}

export function setAppearance(next) {
  localStorage.setItem(storageKey(), JSON.stringify(next));
  applyAppearance();
}

export function applyAppearance() {
  const a = getAppearance();
  const desktop = document.getElementById("desktop");
  if (!desktop) return;

  if (a.kind === "image" && a.imageUrl) {
    desktop.style.background = `url("${escape(a.imageUrl)}") center/cover no-repeat fixed, #0b1220`;
  } else if (a.kind === "solid" && a.solid) {
    desktop.style.background = a.solid;
  } else {
    const preset = APPEARANCE_PRESETS[a.preset || 0] || APPEARANCE_PRESETS[0];
    desktop.style.background = preset.bg;
  }

  if (a.accent) {
    document.documentElement.style.setProperty("--accent", a.accent);
  }
}

function escape(s) { return String(s).replace(/"/g, '\\"'); }
