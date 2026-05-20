// Blizzard Browser — internal "web" with multi-tab, fullscreen (Shift+F),
// built-in URL handlers (blizz://tube, ://store, ://stream, ://ai),
// fuzzy search, and an AI assistant sidebar.

import {
  getSite, listSites,
  siteDataGet, siteDataSet, siteDataPush, siteDataList, siteDataSubscribe
} from "../firebase.js";
import { escapeHtml } from "../os/wm.js";
import { mountTube } from "./tube.js";
import { renderStorefront } from "./store.js";
import { renderTwitchHome } from "./stream.js";
import { renderApisPage } from "./apis.js";
import { renderReportsPage, openReportDialog } from "./reports.js";
import { renderTunes } from "./tunes.js";
import { renderBlizzStore } from "./blizzstore.js";
import { subscribeMyExtensions } from "../firebase.js";

const HOME = "blizz://home";

function tabsStorageKey(uid)     { return `blizzard.browser.tabs.${uid || "guest"}`; }
function bookmarksStorageKey(uid){ return `blizzard.browser.bookmarks.${uid || "guest"}`; }
function loadStoredTabs(uid) {
  try { return JSON.parse(localStorage.getItem(tabsStorageKey(uid)) || "null"); }
  catch { return null; }
}
function saveStoredTabs(uid, payload) {
  localStorage.setItem(tabsStorageKey(uid), JSON.stringify(payload));
}
function loadBookmarks(uid) {
  try { return JSON.parse(localStorage.getItem(bookmarksStorageKey(uid)) || "[]"); }
  catch { return []; }
}
function saveBookmarks(uid, list) {
  localStorage.setItem(bookmarksStorageKey(uid), JSON.stringify(list));
}

// All built-in URLs require a TLD. Bare names (e.g. "tube") fall through to
// the search engine, which will fuzzy-match the .blz form.
const BUILT_INS = {
  "tube.blz":      renderBuiltInTube,
  "blizztube.blz": renderBuiltInTube,
  "store.blz":     renderBuiltInStore,
  "stream.blz":    renderBuiltInStream,
  "twitch.blz":    renderBuiltInStream,
  "apis.blz":      renderBuiltInApis,
  "api.blz":       renderBuiltInApis,
  "reports.blz":   renderBuiltInReports,
  "tunes.blz":     renderBuiltInTunes,
  "music.blz":     renderBuiltInTunes,
  "blizzstore.com": renderBuiltInBlizzStore,
  "blizzstore.blz": renderBuiltInBlizzStore,
  "blizzstore":     renderBuiltInBlizzStore
};

// Synthetic site entries for built-ins so the search engine indexes them.
// Order matters slightly: the "canonical" domain is shown in results.
const BUILT_IN_INDEX = [
  { domain: "blizztube.blz", aliases: ["tube", "blizztube", "videos", "youtube", "watch"],
    description: "BlizzTube — user-uploaded videos. Browse, comment, and post your own clips (YouTube-style)." },
  { domain: "store.blz",   aliases: ["store", "apps", "appstore"],
    description: "Blizzard Store — browse and install apps and games. Includes Blizzard Engine, Paint, Notes, Calculator and more." },
  { domain: "stream.blz",  aliases: ["stream", "twitch", "live", "broadcast"],
    description: "Blizzard Streams — live broadcasts from users. Watch live or start your own stream (Twitch-style)." },
  { domain: "tunes.blz",   aliases: ["tunes", "music", "spotify", "podcast", "podcasts", "songs"],
    description: "Blizzard Tunes — music and podcasts uploaded by users. Discover, listen, and make playlists (Spotify-style)." },
  { domain: "ai.blz",      aliases: ["ai", "assistant", "chatbot"],
    description: "Blizzard AI — a smart assistant that recommends sites and answers questions about the Blizzard network." },
  { domain: "apis.blz",    aliases: ["apis", "api", "docs", "documentation", "voice", "video", "screen", "webrtc", "rtc"],
    description: "API reference — voice, video, screen-share, WebRTC peer-to-peer, and the bz site-data API. Code snippets for building Discord and Twitch clones." },
  { domain: "reports.blz", aliases: ["reports", "moderation", "flagged"],
    description: "Site reports — view sites the community has flagged for review." }
];

function builtInsAsSites() {
  // Shape these like user-published sites so the search ranker treats them uniformly.
  return BUILT_IN_INDEX.map((b) => ({
    domain: b.domain,
    description: b.description,
    aliases: b.aliases,
    isBuiltIn: true,
    files: {},  // empty so content search skips them (description is enough)
    createdAt: Number.MAX_SAFE_INTEGER  // pin to "always relevant"
  }));
}

// Single global postMessage listener that services the `bz.*` API for
// every site iframe in any open browser tab.
if (!window.__bzApiHooked) {
  window.__bzApiHooked = true;
  window.addEventListener("message", async (e) => {
    const msg = e.data;
    if (!msg || msg.__bz !== "req") return;
    const reply = (payload) => e.source?.postMessage({ __bz: "res", id: msg.id, ...payload }, "*");
    try {
      const ctx = window.__bzCtx;  // { user, domain } set by browser when rendering a site
      const sourceCtx = window.__bzSourceCtx?.get(e.source);
      const effective = sourceCtx || ctx;
      if (!effective) return reply({ error: "Site context not initialized." });
      const { fn, args = [] } = msg;
      const handlers = {
        "auth.whoami": () => ({ uid: effective.user.uid, username: effective.user.username }),
        "data.get":    () => siteDataGet(effective.domain, args[0]),
        "data.set":    () => siteDataSet(effective.domain, args[0], args[1]),
        "data.push":   () => siteDataPush(effective.domain, args[0], args[1]),
        "data.list":   () => siteDataList(effective.domain, args[0])
      };
      const h = handlers[fn];
      if (!h) return reply({ error: `Unknown API: ${fn}` });
      const result = await h();
      reply({ result });
    } catch (err) {
      reply({ error: String(err?.message || err) });
    }
  });

  // Live subscribe handler (uses event push messages instead of req/res)
  window.__bzSubs = new Map();
  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg || msg.__bz !== "subscribe") return;
    const ctx = window.__bzSourceCtx?.get(e.source) || window.__bzCtx;
    if (!ctx) return;
    const unsub = siteDataSubscribe(ctx.domain, msg.key, (val) => {
      e.source?.postMessage({ __bz: "evt", subId: msg.subId, value: val }, "*");
    });
    if (!window.__bzSubs.has(e.source)) window.__bzSubs.set(e.source, new Map());
    window.__bzSubs.get(e.source).set(msg.subId, unsub);
  });
  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (!msg || msg.__bz !== "unsubscribe") return;
    const m = window.__bzSubs.get(e.source);
    const u = m?.get(msg.subId);
    if (u) { u(); m.delete(msg.subId); }
  });

  window.__bzSourceCtx = new WeakMap();
}

export async function mountBrowser(root, ctx) {
  root.innerHTML = `
    <div class="app browser">
      <div class="browser-tabs" data-bind="tabs"></div>
      <div class="browser-toolbar">
        <button class="browser-nav-btn" data-act="back" disabled>←</button>
        <button class="browser-nav-btn" data-act="forward" disabled>→</button>
        <button class="browser-nav-btn" data-act="home">⌂</button>
        <button class="browser-nav-btn" data-act="reload">⟳</button>
        <input class="browser-url" type="text" placeholder="Search Blizzard or enter a domain (e.g. mysite.com)" />
        <button class="browser-nav-btn" data-act="star" title="Bookmark this site">☆</button>
        <button class="browser-nav-btn" data-act="bookmarks" title="Bookmarks">📑</button>
        <button class="browser-nav-btn" data-act="report" title="Report this site">⚑</button>
        <button class="browser-nav-btn" data-act="fs" title="Fullscreen (Shift+F)">⛶</button>
      </div>
      <div class="browser-bookmarks hidden" data-bind="bookmarks-bar"></div>
      <div class="browser-body">
        <div class="browser-content">
          <div class="browser-frame" data-bind="frame"></div>
        </div>
      </div>
    </div>
  `;

  const tabsEl    = root.querySelector('[data-bind="tabs"]');
  const frameEl   = root.querySelector('[data-bind="frame"]');
  const urlInput  = root.querySelector(".browser-url");
  const backBtn   = root.querySelector('[data-act="back"]');
  const forwardBtn = root.querySelector('[data-act="forward"]');
  const browserEl = root.querySelector(".browser");

  let tabs = [];
  let activeId = null;
  let nextTabId = 1;
  let bookmarks = loadBookmarks(ctx.user.uid);
  let installedExtensions = []; // live-synced

  const unsubExt = subscribeMyExtensions(ctx.user.uid, (list) => {
    installedExtensions = list.filter((e) => e.enabled !== false);
  });

  // Handle contextmenu requests from site iframes inside this browser.
  function onSiteContextMenu(e) {
    const m = e.data;
    if (!m || m.__bz !== "contextmenu") return;
    // Locate the iframe that posted this message and translate the click
    // coordinates from iframe-local to viewport coordinates.
    let iframe = null;
    for (const ifr of root.querySelectorAll("iframe")) {
      if (ifr.contentWindow === e.source) { iframe = ifr; break; }
    }
    if (!iframe) return;
    const r = iframe.getBoundingClientRect();
    const x = r.left + (m.x || 0);
    const y = r.top  + (m.y || 0);
    showSiteContextMenu(x, y, iframe);
  }
  window.addEventListener("message", onSiteContextMenu);

  function showSiteContextMenu(x, y, iframe) {
    const items = [
      { label: "← Back", action: () => backBtn.click() },
      { label: "↻ Reload", action: () => root.querySelector('[data-act="reload"]').click() },
      { sep: true },
      { label: "View source", action: () => {
          let html = "";
          try { html = iframe.contentDocument?.documentElement?.outerHTML || ""; } catch {}
          if (!html) return;
          newTab("about:source");
          activeTab().title = "Source";
          renderTabs();
          frameEl.innerHTML = `<pre style="margin:0;padding:14px;background:#0a0e18;color:#c8d4eb;font-family:var(--mono);font-size:12px;height:100%;overflow:auto;white-space:pre-wrap;user-select:text">${escapeHtml("<!DOCTYPE html>\n" + html)}</pre>`;
      }},
      { label: "Inspect element", action: () => openInspector(iframe) },
      { label: "Take screenshot", action: () => takeScreenshot(iframe) },
      { sep: true },
      { label: "Bookmark this site", action: () => {
          const t = activeTab();
          if (t && t.url && t.url !== HOME) addBookmark(t.url, t.title);
      }},
      { label: "Report site…", action: () => root.querySelector('[data-act="report"]').click() }
    ];
    showBrowserMenu(x, y, items);
  }

  function openInspector(iframe) {
    let html = "";
    try { html = iframe.contentDocument?.documentElement?.outerHTML || ""; } catch {}
    if (!html) { alert("Can't inspect this frame."); return; }
    const w = window.open("", "_blank", "width=900,height=620");
    if (!w) { alert("Pop-up blocked."); return; }
    w.document.write(`<title>Inspect</title>
      <body style="margin:0;background:#0b1220;color:#eaf2ff;font-family:ui-monospace,Consolas,monospace;display:flex;flex-direction:column;height:100vh">
        <div style="padding:6px 12px;background:#000;color:#fff;font-size:13px;font-family:system-ui">Inspecting · ${escapeHtml(activeTab()?.title || "")}</div>
        <pre style="flex:1;overflow:auto;margin:0;padding:12px;white-space:pre-wrap;font-size:12.5px;user-select:text">${escapeHtml(html)}</pre>
      </body>`);
  }

  async function takeScreenshot(iframe) {
    let html = "";
    try { html = iframe.contentDocument?.documentElement?.outerHTML || ""; } catch {}
    if (!html) { alert("Can't capture this frame."); return; }
    const r = iframe.getBoundingClientRect();
    const w = Math.max(640, Math.floor(r.width));
    const h = Math.max(360, Math.floor(r.height));
    // Render the page's HTML inside an SVG foreignObject → rasterize to canvas.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml">${html}</div>
      </foreignObject>
    </svg>`;
    try {
      const img = new Image();
      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const cx = c.getContext("2d");
      cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h);
      cx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL("image/png");
      const filename = `Screenshot ${new Date().toLocaleString().replace(/[\/:,\s]+/g, "-")}.png`;
      const fileBlob = await (await fetch(dataUrl)).blob();
      const file = new File([fileBlob], filename, { type: "image/png" });
      const FS = await import("../fs.js");
      await FS.uploadFile("/Cloud/My Files/Screenshots", file);
      alert(`Saved /Cloud/My Files/Screenshots/${filename}`);
    } catch (e) {
      alert("Screenshot failed: " + e.message + "\n(External images may be blocked by CORS.)");
    }
  }

  function persistTabs() {
    saveStoredTabs(ctx.user.uid, {
      tabs: tabs.map((t) => ({
        id: t.id, url: t.url, title: t.title, history: t.history, hIndex: t.hIndex, pinned: !!t.pinned
      })),
      activeId,
      nextTabId
    });
  }

  function newTab(initial = HOME) {
    const tab = {
      id: "t" + (nextTabId++),
      url: "",
      title: "New tab",
      history: [],
      hIndex: -1,
      pinned: false
    };
    tabs.push(tab);
    setActive(tab.id);
    renderTabs();
    goto(initial, true);
    persistTabs();
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const tab = tabs[idx];
    if (tab.pinned) return;
    tabs.splice(idx, 1);
    if (tabs.length === 0) {
      newTab(HOME);
      return;
    }
    if (activeId === id) setActive(tabs[Math.max(0, idx - 1)].id);
    renderTabs();
    renderActive();
    persistTabs();
  }

  function setActive(id) {
    activeId = id;
    renderTabs();
    renderActive();
  }

  function activeTab() { return tabs.find((t) => t.id === activeId); }

  function renderTabs() {
    tabsEl.innerHTML = tabs.map((t) => `
      <div class="browser-tab${t.id === activeId ? " active" : ""}${t.pinned ? " pinned" : ""}" data-id="${t.id}" draggable="true">
        ${t.pinned ? `<span style="font-size:10px;opacity:0.7" title="Pinned">📌</span>` : ""}
        <span class="browser-tab-title">${escapeHtml(t.title || "New tab")}</span>
        ${t.pinned ? "" : `<span class="browser-tab-close" data-close="${t.id}">×</span>`}
      </div>
    `).join("") + `<div class="browser-tab-new" data-act="new">+</div>`;

    tabsEl.querySelectorAll(".browser-tab").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("browser-tab-close")) {
          closeTab(e.target.dataset.close);
        } else {
          setActive(el.dataset.id);
        }
      });
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showTabContextMenu(e.clientX, e.clientY, el.dataset.id);
      });
      // Drag to reorder
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/blizz-tab", el.dataset.id);
        e.dataTransfer.effectAllowed = "move";
      });
      el.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        const dragId = e.dataTransfer.getData("text/blizz-tab");
        if (!dragId || dragId === el.dataset.id) return;
        const fromIdx = tabs.findIndex((x) => x.id === dragId);
        const toIdx = tabs.findIndex((x) => x.id === el.dataset.id);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = tabs.splice(fromIdx, 1);
        tabs.splice(toIdx, 0, moved);
        renderTabs();
        persistTabs();
      });
    });
    tabsEl.querySelector('[data-act="new"]').addEventListener("click", () => newTab(HOME));
  }

  function showTabContextMenu(x, y, tabId) {
    const t = tabs.find((x) => x.id === tabId);
    if (!t) return;
    const items = [
      { label: t.pinned ? "Unpin tab" : "Pin tab", action: () => {
          t.pinned = !t.pinned;
          // pinned tabs sort to the left
          tabs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
          renderTabs();
          persistTabs();
      }},
      { label: "Bookmark this tab", action: () => {
          if (t.url && t.url !== HOME) addBookmark(t.url, t.title);
      }},
      { label: "Duplicate", action: () => {
          newTab(t.url || HOME);
      }},
      { sep: true },
      { label: "Close tab", action: () => closeTab(tabId) },
      { label: "Close other tabs", action: () => {
          tabs = tabs.filter((x) => x.id === tabId || x.pinned);
          if (!tabs.find((x) => x.id === activeId)) setActive(tabs[0]?.id);
          renderTabs();
          renderActive();
          persistTabs();
      }},
      { label: "Close tabs to the right", action: () => {
          const idx = tabs.findIndex((x) => x.id === tabId);
          if (idx < 0) return;
          tabs = tabs.filter((x, i) => i <= idx || x.pinned);
          if (!tabs.find((x) => x.id === activeId)) setActive(tabs[0]?.id);
          renderTabs();
          renderActive();
          persistTabs();
      }}
    ];
    showBrowserMenu(x, y, items);
  }

  function showBrowserMenu(x, y, items) {
    const menu = document.getElementById("context-menu");
    menu.innerHTML = "";
    for (const it of items) {
      if (it.sep) {
        const s = document.createElement("div"); s.className = "context-menu-sep"; menu.appendChild(s); continue;
      }
      const row = document.createElement("div");
      row.className = "context-menu-item";
      row.textContent = it.label;
      row.addEventListener("click", () => { menu.classList.add("hidden"); it.action(); });
      menu.appendChild(row);
    }
    menu.style.left = x + "px";
    menu.style.top  = y + "px";
    menu.classList.remove("hidden");
    requestAnimationFrame(() => {
      const r = menu.getBoundingClientRect();
      if (r.right  > window.innerWidth)  menu.style.left = (window.innerWidth  - r.width  - 8) + "px";
      if (r.bottom > window.innerHeight) menu.style.top  = (window.innerHeight - r.height - 8) + "px";
    });
  }

  function addBookmark(url, title) {
    if (bookmarks.find((b) => b.url === url)) {
      // toggle off
      bookmarks = bookmarks.filter((b) => b.url !== url);
    } else {
      bookmarks.push({ url, title: title || url, addedAt: Date.now() });
    }
    saveBookmarks(ctx.user.uid, bookmarks);
    updateStarButton();
    renderBookmarksBar();
  }
  function updateStarButton() {
    const t = activeTab();
    const btn = root.querySelector('[data-act="star"]');
    if (!btn) return;
    const has = t && t.url && t.url !== HOME && bookmarks.find((b) => b.url === t.url);
    btn.textContent = has ? "★" : "☆";
    btn.title = has ? "Remove bookmark" : "Bookmark this site";
  }
  function renderBookmarksBar() {
    const bar = root.querySelector('[data-bind="bookmarks-bar"]');
    if (!bar) return;
    if (bookmarks.length === 0) { bar.classList.add("hidden"); return; }
    bar.classList.remove("hidden");
    bar.innerHTML = bookmarks.map((b) => `
      <span class="bookmark" data-url="${escapeHtml(b.url)}">★ ${escapeHtml(b.title || b.url)}</span>
    `).join("");
    bar.querySelectorAll(".bookmark").forEach((el) => {
      el.addEventListener("click", () => goto(el.dataset.url));
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showBrowserMenu(e.clientX, e.clientY, [
          { label: "Open", action: () => goto(el.dataset.url) },
          { label: "Open in new tab", action: () => newTab(el.dataset.url) },
          { sep: true },
          { label: "Remove bookmark", action: () => {
              bookmarks = bookmarks.filter((b) => b.url !== el.dataset.url);
              saveBookmarks(ctx.user.uid, bookmarks);
              renderBookmarksBar();
              updateStarButton();
          }}
        ]);
      });
    });
  }

  function renderActive() {
    const t = activeTab();
    if (!t) return;
    urlInput.value = t.url === HOME ? "" : t.url;
    backBtn.disabled = t.hIndex <= 0;
    forwardBtn.disabled = t.hIndex >= t.history.length - 1;
    frameEl.innerHTML = "";
    if (!t.url || t.url === HOME) {
      renderHomeInto(frameEl);
    } else {
      resolveAndRender(t.url, frameEl, t);
    }
  }

  async function goto(target, isNew = false) {
    const t = activeTab();
    if (!t) return;
    target = (target || "").trim();
    if (!target) return;
    if (!isNew) {
      t.history.splice(t.hIndex + 1);
      t.history.push(target);
      t.hIndex = t.history.length - 1;
    } else {
      t.history = [target];
      t.hIndex = 0;
    }
    t.url = target;
    urlInput.value = target === HOME ? "" : target;
    backBtn.disabled = t.hIndex <= 0;
    forwardBtn.disabled = t.hIndex >= t.history.length - 1;
    frameEl.innerHTML = "";
    if (target === HOME) {
      renderHomeInto(frameEl);
      setTabTitle(t, "Blizzard");
    } else {
      await resolveAndRender(target, frameEl, t);
    }
    updateStarButton();
    persistTabs();
  }

  function setTabTitle(t, title) {
    t.title = title || "Untitled";
    renderTabs();
  }

  async function resolveAndRender(target, container, tab) {
    const { domain, path, query, hash } = parseBlzUrl(target);

    // Built-in handlers — pass the path so e.g. stream.blz/@username works.
    if (BUILT_INS[domain]) {
      setTabTitle(tab, "blizz://" + domain + (path !== "/" ? path : "") + (hash ? "#" + hash : ""));
      BUILT_INS[domain](container, ctx, goto, tab, setTabTitle, { path, query, hash });
      return;
    }

    // Proper domain
    if (/^[a-z0-9_-]{2,30}\.[a-z]{2,10}$/.test(domain)) {
      const site = await getSite(domain);
      if (site && site.files) {
        const tail = (path !== "/" ? path : "") + (query ? "?" + query : "") + (hash ? "#" + hash : "");
        setTabTitle(tab, domain + tail);
        renderSite(site, container, { path, query, hash });
        return;
      }
    }

    setTabTitle(tab, `Search: ${target}`);
    renderSearchResults(target, container);
  }

  function renderSite(site, container) {
    const index = site.files["index.html"] || Object.values(site.files)[0] || "<h1>Empty site</h1>";
    // Inject the bz API client so the site can call window.bz.*
    let html = inlineSiteAssets(site.files, index);
    // Append installed extensions as content scripts at the end of <body>
    if (installedExtensions.length > 0) {
      const extScripts = installedExtensions.map((ext) =>
        `<script>/* ext: ${JSON.stringify(ext.name || ext.id)} */ try { (function(){\n${ext.code || ""}\n})(); } catch(e) { console.warn("Extension error:", e); }<\/script>`
      ).join("\n");
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, extScripts + "</body>") : html + extScripts;
    }
    const withClient = injectBzClient(html);
    container.innerHTML = `<iframe sandbox="allow-scripts" srcdoc="${escapeAttr(withClient)}" allowfullscreen></iframe>`;
    // After the iframe loads, register its window in the source-context map
    // so postMessage handlers know which site this iframe belongs to.
    const iframe = container.querySelector("iframe");
    iframe.addEventListener("load", () => {
      try {
        if (iframe.contentWindow) {
          window.__bzSourceCtx.set(iframe.contentWindow, {
            user: ctx.user,
            domain: site.domain
          });
        }
      } catch {}
    });
  }

  function renderHomeInto(container) {
    container.innerHTML = `
      <div class="browser-home">
        <div class="browser-home-title">Blizzard</div>
        <div class="browser-home-sub">The internal web inside Blizzard OS</div>
        <div class="browser-home-search">
          <input id="bz-home-q" type="text" placeholder="Search the Blizzard web…" />
          <button class="primary" id="bz-home-go">Search</button>
        </div>
        <div style="margin-top:24px;font-size:12px;color:var(--text-2)">
          Try: <a class="ai-link-domain" data-q="blizz://blizztube.blz">blizz://blizztube.blz</a>,
          <a class="ai-link-domain" data-q="blizz://store.blz">blizz://store.blz</a>,
          <a class="ai-link-domain" data-q="blizz://stream.blz">blizz://stream.blz</a>,
          <a class="ai-link-domain" data-q="blizz://tunes.blz">blizz://tunes.blz</a>,
          <a class="ai-link-domain" data-q="blizz://apis.blz">blizz://apis.blz</a>
        </div>
        <div class="browser-results" id="bz-popular"></div>
      </div>
    `;
    const q = container.querySelector("#bz-home-q");
    q.focus();
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") goto(q.value); });
    container.querySelector("#bz-home-go").addEventListener("click", () => goto(q.value));
    container.querySelectorAll("[data-q]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); goto(a.dataset.q); }));

    listSites().then((sites) => {
      const popularEl = container.querySelector("#bz-popular");
      if (!popularEl) return;
      if (sites.length === 0) {
        popularEl.innerHTML = `<div class="muted" style="text-align:center;margin-top:30px">
          No sites yet. Use Blizzard Studios or the Terminal to publish the first one.
        </div>`;
        return;
      }
      popularEl.innerHTML = `<h3 style="color:var(--text-2);font-weight:500;letter-spacing:0.5px;text-transform:uppercase;font-size:12px;margin:30px 0 10px">Recently published</h3>` +
        sites.slice(0, 12).map((s) => `
          <div class="browser-result" data-domain="${escapeHtml(s.domain)}">
            <div class="browser-result-domain">blizz://${escapeHtml(s.domain)}</div>
            <div class="browser-result-title">${escapeHtml(s.domain)}</div>
            <div class="browser-result-snippet">${escapeHtml(s.description || "—")}</div>
          </div>
        `).join("");
      popularEl.querySelectorAll("[data-domain]").forEach((r) =>
        r.addEventListener("click", () => goto(r.dataset.domain))
      );
    });
  }

  async function renderSearchResults(q, container) {
    container.innerHTML = `
      <div class="browser-home" style="padding-top: 28px;">
        <div class="browser-home-search">
          <input id="bz-rsq" type="text" value="${escapeHtml(q)}" />
          <button class="primary" id="bz-rsg">Search</button>
        </div>
        <div style="max-width:700px;margin:14px auto 0;color:var(--text-2);font-size:12px" data-bind="meta">Searching the Blizzard web…</div>
        <div class="browser-results" data-bind="results"></div>
      </div>
    `;
    const meta = container.querySelector('[data-bind="meta"]');
    const results = container.querySelector('[data-bind="results"]');
    container.querySelector("#bz-rsg").addEventListener("click", () => goto(container.querySelector("#bz-rsq").value));
    container.querySelector("#bz-rsq").addEventListener("keydown", (e) => { if (e.key === "Enter") goto(container.querySelector("#bz-rsq").value); });

    const userSites = await listSites();
    // Built-ins live alongside user-published sites in the index so the
    // ranker treats them the same way.
    const sites = [...builtInsAsSites(), ...userSites];
    const ranked = fullSearchRank(q, sites);
    const exactDom = q.replace(/^blizz(?:ard)?:\/\//, "").split("/")[0].toLowerCase();
    const closest = ranked[0];
    const didYouMean = (closest && closest.score >= 50 && closest.site.domain !== exactDom && /^[a-z0-9_.-]+$/.test(exactDom))
      ? closest.site.domain : null;

    if (ranked.length === 0) {
      // Google-style empty state.
      meta.innerHTML = "";
      results.innerHTML = `
        <div style="max-width:640px;margin:24px auto 0;color:var(--text-1);font-size:13.5px;line-height:1.55">
          <div style="margin-bottom:18px">
            Your search - <b style="color:var(--text-0)">${escapeHtml(q)}</b> - did not match any documents.
          </div>
          <div style="margin-bottom:6px;color:var(--text-0)">Suggestions:</div>
          <ul style="margin:0;padding-left:20px">
            <li>Make sure all words are spelled correctly.</li>
            <li>Try different keywords.</li>
            <li>Try more general keywords.</li>
            <li>Or <a class="ai-link-domain" data-domain="store.blz">browse the store</a> · <a class="ai-link-domain" data-domain="tube.blz">watch something</a> · <a class="ai-link-domain" data-domain="tunes.blz">listen to music</a>.</li>
          </ul>
          <div style="margin-top:24px;text-align:center;font-size:60px;opacity:0.5">🎣</div>
        </div>
      `;
      results.querySelectorAll("[data-domain]").forEach((a) =>
        a.addEventListener("click", () => goto(a.dataset.domain))
      );
      return;
    }

    meta.innerHTML = `
      About ${ranked.length} result${ranked.length === 1 ? "" : "s"} for <b>${escapeHtml(q)}</b>
      ${didYouMean ? ` · Did you mean <a class="ai-link-domain" data-domain="${escapeHtml(didYouMean)}">${escapeHtml(didYouMean)}</a>?` : ""}
    `;
    meta.querySelectorAll("[data-domain]").forEach((a) =>
      a.addEventListener("click", () => goto(a.dataset.domain))
    );

    results.innerHTML = ranked.map(({ site, snippet }) => `
      <div class="browser-result" data-domain="${escapeHtml(site.domain)}">
        <div class="browser-result-domain">blizz://${escapeHtml(site.domain)}${site.isBuiltIn ? ' · <span style="color:var(--accent-2);font-weight:600">Built-in</span>' : ""}</div>
        <div class="browser-result-title">${highlight(site.domain, q)}</div>
        <div class="browser-result-snippet">${snippet ? highlight(snippet, q) : highlight(site.description || "—", q)}</div>
      </div>
    `).join("");
    results.querySelectorAll(".browser-result").forEach((r) =>
      r.addEventListener("click", () => goto(r.dataset.domain))
    );
  }

  // Toolbar wiring
  urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") goto(urlInput.value); });
  backBtn.addEventListener("click", () => {
    const t = activeTab();
    if (t && t.hIndex > 0) {
      t.hIndex--;
      const target = t.history[t.hIndex];
      t.url = target;
      urlInput.value = target === HOME ? "" : target;
      backBtn.disabled = t.hIndex <= 0;
      forwardBtn.disabled = t.hIndex >= t.history.length - 1;
      frameEl.innerHTML = "";
      if (target === HOME) renderHomeInto(frameEl);
      else resolveAndRender(target, frameEl, t);
    }
  });
  forwardBtn.addEventListener("click", () => {
    const t = activeTab();
    if (t && t.hIndex < t.history.length - 1) {
      t.hIndex++;
      const target = t.history[t.hIndex];
      t.url = target;
      urlInput.value = target === HOME ? "" : target;
      backBtn.disabled = t.hIndex <= 0;
      forwardBtn.disabled = t.hIndex >= t.history.length - 1;
      frameEl.innerHTML = "";
      if (target === HOME) renderHomeInto(frameEl);
      else resolveAndRender(target, frameEl, t);
    }
  });
  root.querySelector('[data-act="home"]').addEventListener("click", () => goto(HOME));
  root.querySelector('[data-act="reload"]').addEventListener("click", () => {
    const t = activeTab();
    if (t) {
      frameEl.innerHTML = "";
      if (t.url === HOME) renderHomeInto(frameEl);
      else resolveAndRender(t.url, frameEl, t);
    }
  });
  root.querySelector('[data-act="star"]').addEventListener("click", () => {
    const t = activeTab();
    if (!t || !t.url || t.url === HOME) return;
    addBookmark(t.url, t.title);
  });
  root.querySelector('[data-act="bookmarks"]').addEventListener("click", (e) => {
    if (bookmarks.length === 0) {
      alert("No bookmarks yet. Click ☆ on a page to add one.");
      return;
    }
    showBrowserMenu(e.clientX, e.clientY,
      bookmarks.map((b) => ({ label: "★ " + (b.title || b.url), action: () => goto(b.url) }))
        .concat([{ sep: true }, { label: "Manage bookmarks…", action: () => renderBookmarksBar() }])
    );
  });
  root.querySelector('[data-act="report"]').addEventListener("click", () => {
    const t = activeTab();
    if (!t || !t.url || t.url === HOME) return;
    let dom = t.url.replace(/^blizz(?:ard)?:\/\//, "").split("/")[0].toLowerCase();
    if (!/^[a-z0-9_-]{2,30}\.[a-z]{2,10}$/.test(dom)) {
      alert("You can only report a real site (e.g. blizz://example.com).");
      return;
    }
    openReportDialog(dom, ctx);
  });
  // Fullscreen (Shift+F) — only in the browser window
  root.querySelector('[data-act="fs"]').addEventListener("click", () => toggleFullscreen());
  ctx.win.el.addEventListener("keydown", (e) => {
    if (e.shiftKey && (e.key === "F" || e.key === "f") &&
        !["INPUT", "TEXTAREA"].includes((document.activeElement?.tagName || "").toUpperCase())) {
      e.preventDefault();
      toggleFullscreen();
    }
  });
  // Make the window focusable so the keydown above works
  ctx.win.el.tabIndex = -1;

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      ctx.win.el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  // Restore tabs from previous session, or open initial query / HTML.
  const restored = loadStoredTabs(ctx.user.uid);
  const hasInitial = ctx.initialQuery || ctx.initialHtml;
  if (restored && Array.isArray(restored.tabs) && restored.tabs.length > 0 && !hasInitial) {
    tabs = restored.tabs.map((t) => ({ ...t, history: t.history || [], hIndex: t.hIndex ?? -1 }));
    nextTabId = restored.nextTabId || (tabs.length + 1);
    setActive(restored.activeId && tabs.find((t) => t.id === restored.activeId) ? restored.activeId : tabs[0].id);
  } else if (ctx.initialHtml) {
    // Open an in-memory HTML payload in a new tab (used for opening
    // .html / .blz files from File Explorer or installing games).
    if (restored?.tabs?.length > 0) {
      tabs = restored.tabs.map((t) => ({ ...t, history: t.history || [], hIndex: t.hIndex ?? -1 }));
      nextTabId = restored.nextTabId || (tabs.length + 1);
      setActive(restored.activeId && tabs.find((t) => t.id === restored.activeId) ? restored.activeId : tabs[0].id);
    }
    openHtmlInNewTab(ctx.initialHtml, ctx.initialTitle || "Local file");
  } else {
    newTab(ctx.initialQuery || HOME);
  }
  renderBookmarksBar();
  updateStarButton();

  // Listen for OS-wide requests to open an HTML payload in this browser.
  function handleOpenHtml(e) {
    const { html, title } = e.detail || {};
    if (!html) return;
    openHtmlInNewTab(html, title || "Local file");
  }
  document.addEventListener("blizzard:open-html-tab", handleOpenHtml);

  function openHtmlInNewTab(html, title) {
    const tab = {
      id: "t" + (nextTabId++),
      url: "_local:" + title,
      title: title,
      history: ["_local:" + title],
      hIndex: 0,
      pinned: false,
      _scratchHtml: html
    };
    tabs.push(tab);
    setActive(tab.id);
    renderTabs();
    frameEl.innerHTML = `<iframe sandbox="allow-scripts allow-forms allow-same-origin" srcdoc="${escapeAttr(html)}" allowfullscreen></iframe>`;
    urlInput.value = "(local) " + title;
    persistTabs();
  }

  return () => {
    document.removeEventListener("blizzard:open-html-tab", handleOpenHtml);
    window.removeEventListener("message", onSiteContextMenu);
    if (unsubExt) unsubExt();
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    persistTabs();
  };
}

// Built-in URL handlers ------------------------------------------------------
async function renderBuiltInTube(container, ctx, navigate, tab, setTitle) {
  setTitle(tab, "BlizzTube");
  container.innerHTML = "";
  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column;flex:1;min-height:0";
  container.appendChild(host);
  await mountTube(host, ctx);
}
async function renderBuiltInStore(container, ctx, navigate, tab, setTitle) {
  setTitle(tab, "Blizzard Store");
  container.innerHTML = "";
  await renderStorefront(container, ctx);
}
async function renderBuiltInStream(container, ctx, navigate, tab, setTitle, route) {
  setTitle(tab, "Blizzard Streams");
  container.innerHTML = "";
  // Path of form "/@username" → open that streamer's channel directly.
  const m = (route?.path || "").match(/^\/+@?([a-zA-Z0-9_]{3,20})\b/);
  if (m) {
    await renderTwitchHome(container, ctx);
    // Then auto-navigate to the username's stream if they're live.
    if (container.__bzOpenViewerByUsername) {
      container.__bzOpenViewerByUsername(m[1].toLowerCase());
    }
    return;
  }
  await renderTwitchHome(container, ctx);
}
async function renderBuiltInApis(container, ctx, navigate, tab, setTitle, route) {
  setTitle(tab, "Blizzard APIs" + ((route?.path && route.path !== "/") ? " · " + route.path.slice(1) : ""));
  container.innerHTML = "";
  await renderApisPage(container, ctx, navigate, route);
}
async function renderBuiltInReports(container, ctx, navigate, tab, setTitle) {
  setTitle(tab, "Reports");
  container.innerHTML = "";
  await renderReportsPage(container, ctx, navigate);
}
async function renderBuiltInTunes(container, ctx, navigate, tab, setTitle) {
  setTitle(tab, "Blizzard Tunes");
  container.innerHTML = "";
  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;display:flex";
  container.appendChild(host);
  await renderTunes(host, ctx);
}
async function renderBuiltInBlizzStore(container, ctx, navigate, tab, setTitle, route) {
  setTitle(tab, "Blizz Web Store");
  container.innerHTML = "";
  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column;flex:1;min-height:0;background:var(--bg-1);color:var(--text-0)";
  container.appendChild(host);
  host.__bzNav = (target) => navigate(target);
  await renderBlizzStore(host, ctx, route);
}

// Helpers --------------------------------------------------------------------
// Inject window.bz client into a site's HTML. The client talks to the parent
// window via postMessage; the parent is the OS browser tab, which has the
// global handler registered above.
function injectBzClient(html) {
  const client = `<script>
(function(){
  if (window.bz) return;
  // Intercept right-click and forward to the parent so the Blizzard browser
  // can show its own context menu (Inspect, View Source, Screenshot, etc.)
  // instead of the host browser's default.
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    parent.postMessage({ __bz: "contextmenu", x: e.clientX, y: e.clientY }, "*");
  }, true);
  const pending = new Map();
  let nextId = 1;
  let nextSub = 1;
  const subs = new Map();
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || !m.__bz) return;
    if (m.__bz === "res") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if ("error" in m) p.reject(new Error(m.error));
      else p.resolve(m.result);
    } else if (m.__bz === "evt") {
      const cb = subs.get(m.subId);
      if (cb) cb(m.value);
    }
  });
  function call(fn, args) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      parent.postMessage({ __bz: "req", id, fn, args }, "*");
    });
  }
  window.bz = {
    auth: { whoami: () => call("auth.whoami") },
    data: {
      get:  (k) => call("data.get",  [k]),
      set:  (k, v) => call("data.set",  [k, v]),
      push: (k, v) => call("data.push", [k, v]),
      list: (k) => call("data.list", [k]),
      subscribe: (k, cb) => {
        const subId = nextSub++;
        subs.set(subId, cb);
        parent.postMessage({ __bz: "subscribe", subId, key: k }, "*");
        return () => {
          subs.delete(subId);
          parent.postMessage({ __bz: "unsubscribe", subId }, "*");
        };
      }
    }
  };
})();
<\/script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + client);
  if (/<body[^>]*>/i.test(html)) return html.replace(/<body[^>]*>/i, (m) => m + client);
  return client + html;
}

// Parse a blizz://domain.tld/path?q#hash URL into structured parts.
function parseBlzUrl(target) {
  let s = String(target || "").replace(/^blizz(?:ard)?:\/\//, "").replace(/^\/+/, "");
  let hash = "", query = "";
  const hi = s.indexOf("#");
  if (hi >= 0) { hash = s.slice(hi + 1); s = s.slice(0, hi); }
  const qi = s.indexOf("?");
  if (qi >= 0) { query = s.slice(qi + 1); s = s.slice(0, qi); }
  const si = s.indexOf("/");
  const domain = (si >= 0 ? s.slice(0, si) : s).toLowerCase();
  const path = si >= 0 ? s.slice(si) : "/";
  return { domain, path, query, hash };
}

function inlineSiteAssets(files, html) {
  return html
    .replace(/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/gi, (m, name) => {
      const css = files[name];
      return css ? `<style>${css}</style>` : m;
    })
    .replace(/<script[^>]+src=["']([^"']+\.js)["'][^>]*><\/script>/gi, (m, name) => {
      const js = files[name];
      return js ? `<script>${js}</script>` : m;
    });
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
  }[c]));
}

// Fuzzy match (Levenshtein-based) + substring weighting.
function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[b.length];
}

// Like fuzzyRank but also scans site file contents and aliases, returns a
// snippet for content matches. Used for the search-results page (Google-like).
function fullSearchRank(query, sites) {
  const q = (query || "").toLowerCase().replace(/^blizz(?:ard)?:\/\//, "").trim();
  if (!q) return [];
  const terms = q.split(/\s+/).filter(Boolean);
  const out = [];
  for (const site of sites) {
    const dom = (site.domain || "").toLowerCase();
    const domBare = dom.split(".")[0]; // "tube" from "tube.blz"
    const desc = (site.description || "").toLowerCase();
    const aliases = (site.aliases || []).map((a) => a.toLowerCase());
    let score = 0;
    let snippet = null;

    if (dom === q)              score += 120;
    if (domBare === q)          score += 100;     // user typed "tube" → match "tube.blz"
    if (aliases.includes(q))    score += 90;
    if (dom.includes(q))        score += 60;
    if (domBare.includes(q))    score += 55;
    if (desc.includes(q))       score += 30;
    if (aliases.some((a) => a.includes(q))) score += 25;
    for (const t of terms) {
      if (dom.includes(t))      score += 14;
      if (domBare.includes(t))  score += 12;
      if (desc.includes(t))     score += 8;
      if (aliases.some((a) => a.includes(t))) score += 7;
    }
    // Fuzzy proximity to the bare domain (catches typos like "tubes" → "tube")
    const lev = Math.min(levenshtein(dom, q), levenshtein(domBare, q));
    if (lev <= 3 && dom.length > 0) score += Math.max(0, 50 - lev * 12);
    // Fuzzy match to aliases
    for (const a of aliases) {
      const lva = levenshtein(a, q);
      if (lva <= 2) score += Math.max(0, 35 - lva * 12);
    }

    // Search through page content (skipped for built-ins which have empty files)
    const files = site.files || {};
    const html = files["index.html"] || Object.values(files)[0] || "";
    if (html) {
      const lowerText = stripHtml(html).toLowerCase();
      if (lowerText.includes(q)) {
        score += 25;
        snippet = extractSnippet(lowerText, q);
      } else {
        for (const t of terms) {
          if (lowerText.includes(t)) { score += 6; snippet = snippet || extractSnippet(lowerText, t); }
        }
      }
    }

    if (score > 0) out.push({ site, score, snippet });
  }
  return out.sort((a, b) => b.score - a.score);
}

function stripHtml(html) {
  return String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}
function extractSnippet(text, term, around = 80) {
  const i = text.indexOf(term);
  if (i < 0) return null;
  const start = Math.max(0, i - around);
  const end = Math.min(text.length, i + term.length + around);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}
function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const safe = escapeHtml(String(text || ""));
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return safe;
  const re = new RegExp("(" + terms.map(escRe).join("|") + ")", "gi");
  return safe.replace(re, "<mark style=\"background:rgba(255,214,110,0.25);color:inherit\">$1</mark>");
}
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function fuzzyRank(query, sites) {
  const q = (query || "").toLowerCase().replace(/^blizz(?:ard)?:\/\//, "").trim();
  if (!q) return sites.map((site) => ({ site, score: 0 }));
  return sites
    .map((site) => {
      const dom = (site.domain || "").toLowerCase();
      const desc = (site.description || "").toLowerCase();
      let score = 0;
      if (dom === q)               score += 100;
      if (dom.includes(q))         score += 60;
      if (desc.includes(q))        score += 30;
      for (const word of q.split(/\s+/)) {
        if (!word) continue;
        if (dom.includes(word))    score += 20;
        if (desc.includes(word))   score += 10;
      }
      const lev = levenshtein(dom, q);
      if (lev <= 2 && dom.length > 0) score += Math.max(0, 50 - lev * 12);
      return { site, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}
