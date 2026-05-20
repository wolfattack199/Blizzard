# Blizzard OS

A browser-based simulated operating system with its own internal web ecosystem,
real-time messaging, cloud-synced files, livestreaming, and a developer toolchain.
Built with vanilla HTML / CSS / JavaScript and a Firebase Realtime Database backend.

## Highlights

- **Windows-style desktop** — draggable icons, draggable + resizable windows, taskbar with pinning, Start menu with search, clock + calendar popup, custom wallpapers and accent colors.
- **Real-time messaging** — Discord-style server bar with channels, DMs, user-created servers, and a built-in Inbox (email-style threaded chat).
- **Cloud-synced file explorer** — multi-tab, marquee selection, drag-and-drop upload, per-user `/Cloud/My Files` and `/Cloud/Shared with me` synced via Firebase, rubber-band selection, share-with-username, .blz bundle/unbundle.
- **Blizzard browser** — multi-tab with persistence, fuzzy + content-aware search, bookmarks, Shift+F fullscreen, custom right-click menu (Inspect / View Source / Screenshot), `blizz://` URL scheme with paths + hash routing, browser extensions.
- **Built-in URLs** —
  - `blizz://blizztube.blz` — user-uploaded videos with comments and tags
  - `blizz://store.blz` — Blizzard Store for apps
  - `blizz://blizzstore.com` — Blizz Web Store for browser extensions (`/dev` to publish)
  - `blizz://stream.blz` — Twitch-like live streams (also `stream.blz/@username`)
  - `blizz://tunes.blz` — Spotify-like music + podcasts
  - `blizz://apis.blz` — full API reference (with `/section` deep links)
  - `blizz://reports.blz` — moderation queue
- **Livestreaming** — OBS-style broadcaster (camera / mic / screen share / audio mixer / chat overlay / record-to-cloud + publish-to-BlizzTube). Viewers watch via WebRTC with a real-time chat sidebar.
- **Blizzard Studios** — VSCode-style IDE: Open Folder, project tree, tabbed editor, **auto-save**, Run-in-browser, Publish-to-site, Terminal app with `bundle / unbundle / clone / publish / api install` commands.
- **Blizzard Engine** — drag-and-drop 2D game maker that exports playable HTML5 games to the Community Hub.
- **Site routing** — published sites support paths and hash fragments (`example.com/login`, `example.com/app#chat`), exposed to site code via `window.bz`.
- **Extensions** — JavaScript content scripts that run inside Blizzard sites. Publish your own at `blizz://blizzstore.com/dev`.
- **Remembered sign-in** — the auth screen remembers your profile picture and username; only the password is required to come back.

## Running locally

You can double-click `index.html` to open Blizzard directly in Chrome, Edge, or
ChromeOS. `index.html` includes a bundled copy of the app for `file://` launches,
so you do not need Dev Mode or Visual Studio just to use it.

If you are editing the source files, serve the folder over HTTP so the browser
loads the separate modules from `js/`:

```sh
npx serve .
# or
python -m http.server 8000
```

Then visit `http://localhost:8000`.

After changing files in `js/`, rebuild the double-click bundle:

```sh
node tools/build-file-bundle.mjs
```

ChromeOS note: Firebase still needs internet access to Google Firebase domains
such as `www.gstatic.com`, `firebaseapp.com`, `googleapis.com`, and the
Realtime Database URL in `js/config.js`. If those are blocked by a school or
managed device policy, Blizzard will open but login/cloud features cannot
connect until they are allowed.

## Firebase setup

The OS uses Firebase Realtime Database + Auth. Configure your own project in
[`js/config.js`](js/config.js).

1. Create a Firebase project at <https://console.firebase.google.com/>.
2. Add a Web app and copy its `firebaseConfig` object into `js/config.js`.
3. Enable **Authentication → Email/Password**.
4. Create a **Realtime Database**. **See [SECURITY.md](SECURITY.md) for the production rules — DO NOT leave the DB in test mode.**

## License

MIT.
