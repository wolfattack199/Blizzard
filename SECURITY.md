# Security notes

## Your Firebase database is currently in TEST MODE

Test mode rules allow **anyone authenticated** (i.e. anyone who can create an
account on your Blizzard) to read and write **any data anywhere** in the
database. They expire automatically after 30 days, but in the meantime they're
permissive.

`js/config.js` contains your Firebase project's `apiKey`, `databaseURL`, etc.
These values are **not secrets** in the traditional sense — every deployed
Firebase web client embeds them — but they DO identify your project. Database
security is supposed to be enforced by **Realtime Database Rules**, not by
hiding the config.

## Tighten the rules before going public

Open Firebase console → **Build → Realtime Database → Rules**, replace the
test-mode rules with something like the policy below, and click Publish.

```json
{
  "rules": {
    "users": {
      ".read": "auth != null",
      "$uid": {
        ".write": "auth.uid === $uid && (!data.exists() || (newData.child('role').val() === data.child('role').val() && newData.child('banned').val() === data.child('banned').val() && newData.child('timeout').val() === data.child('timeout').val() && newData.child('appBans').val() === data.child('appBans').val() && newData.child('quota_tier').val() === data.child('quota_tier').val()))",
        "role": {
          ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'"
        },
        "banned": {
          ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'"
        },
        "timeout": {
          ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'"
        },
        "appBans": {
          ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'"
        },
        "quota_tier": {
          ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'"
        },
        "storage_used": {
          ".write": "$uid === auth.uid"
        },
        "storage_breakdown": {
          ".write": "$uid === auth.uid"
        },
        "storage_backfilledAt": {
          ".write": "$uid === auth.uid"
        },
        "counters": {
          ".write": "$uid === auth.uid"
        },
        "achievements": {
          ".write": "$uid === auth.uid || root.child('users').child(auth.uid).child('role').val() === 'admin'"
        },
        "points": {
          ".write": "$uid === auth.uid || root.child('users').child(auth.uid).child('role').val() === 'admin'"
        },
        "warnings": {
          ".write": "auth != null && (root.child('users').child(auth.uid).child('role').val() === 'admin' || root.child('users').child(auth.uid).child('role').val() === 'mod')",
          "$warning": {
            "acknowledgedAt": {
              ".write": "$uid === auth.uid"
            }
          }
        }
      }
    },
    "usernames": {
      ".read": "auth != null",
      "$name": {
        ".write": "!data.exists() && auth != null"
      }
    },
    "channels": {
      ".read": "auth != null",
      ".write": "auth != null"
    },
    "messages": {
      ".read": "auth != null",
      ".write": "auth != null"
    },
    "sites": {
      ".read": "auth != null",
      "$domain": {
        ".write": "auth != null && (!data.exists() || data.child('owner').val() === auth.uid || data.child('collaborators').child(auth.uid).val() === true)"
      }
    },
    "games":    { ".read": "auth != null", ".write": "auth != null" },
    "game_rooms": { ".read": "auth != null", ".write": "auth != null" },
    "achievements_catalog": {
      ".read": "auth != null",
      ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'"
    },
    "tubes":    { ".read": "auth != null", ".write": "auth != null" },
    "tunes":    { ".read": "auth != null", ".write": "auth != null" },
    "tube-blobs": { ".read": "auth != null", ".write": "auth != null" },
    "tune-blobs": { ".read": "auth != null", ".write": "auth != null" },
    "apps":     { ".read": "auth != null", ".write": "auth != null" },
    "extensions": { ".read": "auth != null", ".write": "auth != null" },
    "installed": {
      "$uid": {
        ".read": "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    },
    "installed-ext": {
      "$uid": {
        ".read": "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    },
    "desktop-layouts": {
      "$uid": {
        ".read": "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    },
    "cloud-files": {
      "$uid": {
        ".read": "auth != null",
        ".write": "$uid === auth.uid"
      }
    },
    "cloud-blobs": {
      "$uid": {
        ".read": "auth != null",
        ".write": "$uid === auth.uid"
      }
    },
    "cloud-folders": {
      "$uid": {
        ".read": "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    },
    "cloud-shares": {
      "$uid": {
        ".read": "$uid === auth.uid",
        ".write": "auth != null"
      }
    },
    "notes": {
      "$uid": {
        ".read": "$uid === auth.uid",
        ".write": "$uid === auth.uid"
      }
    },
    "mail":     { ".read": "auth != null", ".write": "auth != null" },
    "playlists": {
      "$uid": {
        ".read": "auth != null",
        ".write": "$uid === auth.uid"
      }
    },
    "streams":  { ".read": "auth != null", ".write": "auth != null" },
    "stream-chat": { ".read": "auth != null", ".write": "auth != null" },
    "siteData": { ".read": "auth != null", ".write": "auth != null" },
    "reports":  { ".read": "auth != null", ".write": "auth != null" },
    "servers":  { ".read": "auth != null", ".write": "auth != null" },
    "serverMessages": { ".read": "auth != null", ".write": "auth != null" },
    "admin_audit_log": {
      ".read": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'",
      "$entry": {
        ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin' && !data.exists()"
      }
    },
    "mod_audit_log": {
      ".read": "auth != null && (root.child('users').child(auth.uid).child('role').val() === 'admin' || root.child('users').child(auth.uid).child('role').val() === 'mod')",
      "$entry": {
        ".write": "auth != null && (root.child('users').child(auth.uid).child('role').val() === 'admin' || root.child('users').child(auth.uid).child('role').val() === 'mod') && !data.exists()"
      }
    },
    "mod_queue": {
      ".read": "auth != null && (root.child('users').child(auth.uid).child('role').val() === 'admin' || root.child('users').child(auth.uid).child('role').val() === 'mod')",
      ".write": "auth != null"
    },
    "admin_alerts": {
      ".read": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'",
      ".write": "auth != null"
    },
    "moderation": {
      ".read": "auth != null",
      ".write": "auth != null && root.child('users').child(auth.uid).child('role').val() === 'admin'"
    }
  }
}
```

These rules:
- Make every Blizzard user able to **read** public-ish data (sites, games, tubes, tunes, channels, messages, streams).
- Restrict **writes** to the owner where it matters (own profile, own cloud files, own installed apps, own desktop layout).
- Allow any authenticated user to **publish** sites and to read any other user's profile (needed for the user picker and Profiles app).
- Are still permissive on `messages`, `channels`, etc. because Blizzard is a small community OS — you may want to tighten those further (e.g., require server membership for serverMessages).

## What's still risky after locking down

- Anyone can create an account (`createUserWithEmailAndPassword`). This is by
  design — if you want to gate sign-ups, switch to invite-only via Cloud
  Functions.
- Anyone can publish a site, post to `#general`, upload a game/video/tune,
  publish an extension, or report another site/stream. There's a `blizz://reports.blz`
  page where you can review reports manually.
- Extensions run JS inside other users' Blizzard sessions. Treat publishing
  permissions accordingly.
