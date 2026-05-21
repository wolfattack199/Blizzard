// App registry — single source of truth for installed apps.
import { mountFiles }      from "../apps/files.js";
import { mountMessenger }  from "../apps/messenger.js";
import { mountCommunity }  from "../apps/community.js";
import { mountBrowser }    from "../apps/browser.js";
import { mountStudios }    from "../apps/studios.js";
import { mountTerminal }   from "../apps/terminal.js";
import { mountBuilder }    from "../apps/builder.js";
import { mountSettings }   from "../apps/settings.js";
import { mountNotes }      from "../apps/notes.js";
import { mountStore }      from "../apps/store.js";
import { mountEngine }     from "../apps/engine.js";
import { mountLivestream } from "../apps/livestream.js";
import { mountTunes }      from "../apps/tunes.js";
// Inbox is no longer a standalone app — it lives inside Messenger as the ✉ server.
import { mountCalculator } from "../apps/calculator.js";
import { mountPaint }      from "../apps/paint.js";
import { mountProfiles }   from "../apps/profiles.js";
import { mountMusic }      from "../apps/music.js";
import { mountAdmin }      from "../apps/admin.js";
import { mountMod }        from "../apps/mod.js";
import { mountAchievements } from "../apps/achievements.js";

export const APPS = [
  { id: "files",      name: "File Explorer",    glyph: "📁", mount: mountFiles,      width: 740, height: 480, desktop: true },
  { id: "messenger",  name: "GuildWire",        glyph: "💬", mount: mountMessenger,  width: 880, height: 560, desktop: true },
  { id: "browser",    name: "Blizzard",         glyph: "❄",  mount: mountBrowser,    width: 880, height: 560, desktop: true },
  { id: "store",      name: "Blizzard Store",   glyph: "🛍", mount: mountStore,      width: 880, height: 580, desktop: true },
  { id: "community",  name: "Community Hub",    glyph: "🎮", mount: mountCommunity,  width: 820, height: 560, desktop: true },
  { id: "livestream", name: "Livestream",       glyph: "🔴", mount: mountLivestream, width: 760, height: 540, desktop: true },
  { id: "tunes",      name: "Music",            glyph: "🎶", mount: mountTunes,      width: 940, height: 600, desktop: true },
  { id: "engine",     name: "Blizzard Engine",  glyph: "🎯", mount: mountEngine,     width: 980, height: 620, desktop: false, storeOnly: true },
  { id: "studios",    name: "Blizzard Studios", glyph: "🛠", mount: mountStudios,    width: 940, height: 600, desktop: true },
  { id: "builder",    name: "Site Builder",     glyph: "🧩", mount: mountBuilder,    width: 980, height: 620, desktop: true },
  { id: "terminal",   name: "Terminal",         glyph: "▶_", mount: mountTerminal,   width: 700, height: 420, desktop: true },
  { id: "profiles",   name: "Users",            glyph: "👥", mount: mountProfiles,   width: 760, height: 520, desktop: true },
  { id: "notes",      name: "Notes",            glyph: "📝", mount: mountNotes,      width: 600, height: 440, desktop: false },
  { id: "music",      name: "Music",            glyph: "🎵", mount: mountMusic,      width: 560, height: 440, desktop: false },
  { id: "paint",      name: "Paint",            glyph: "🎨", mount: mountPaint,      width: 880, height: 580, desktop: false },
  { id: "calculator", name: "Calculator",       glyph: "🧮", mount: mountCalculator, width: 300, height: 460, desktop: false },
  { id: "settings",   name: "Settings",         glyph: "⚙",  mount: mountSettings,   width: 720, height: 480, desktop: false },
  // Admin Console + Mod Queue are intentionally hidden from the start menu.
  // The only way to reach them is the terminal's `ghiy` command (which now
  // asks for a username + password before launching).
  { id: "admin",      name: "Admin Console",    glyph: "ADM",  mount: mountAdmin,      width: 980, height: 640, desktop: false, hidden: true },
  { id: "mod",        name: "Mod Queue",        glyph: "MOD",  mount: mountMod,        width: 920, height: 600, desktop: false, hidden: true },
  { id: "achievements", name: "Achievements",  glyph: "ACH",  mount: mountAchievements, width: 820, height: 600, desktop: false }
];

export function getApp(id) { return APPS.find((a) => a.id === id); }
