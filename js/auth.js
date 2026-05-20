// Auth UI: drives the sign-in / sign-up screen and resolves to a Firebase user.
import {
  auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  usernameToEmail,
  isUsernameTaken,
  registerUsername,
  loadUser
} from "./firebase.js";

let mode = "login";

const LAST_USER_KEY = "blizzard.lastUser";

function el(id) { return document.getElementById(id); }

function rememberUser(profile) {
  try {
    localStorage.setItem(LAST_USER_KEY, JSON.stringify({
      username: profile.username,
      avatarUrl: profile?.profile?.avatarUrl || profile?.avatarUrl || ""
    }));
  } catch {}
}
export function clearRememberedUser() {
  try { localStorage.removeItem(LAST_USER_KEY); } catch {}
}
function loadRememberedUser() {
  try { return JSON.parse(localStorage.getItem(LAST_USER_KEY) || "null"); }
  catch { return null; }
}

function setMode(next) {
  mode = next;
  document.querySelectorAll(".auth-tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === mode));
  el("auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
  el("auth-error").textContent = "";
}

function setError(msg) {
  el("auth-error").textContent = msg || "";
}

function setLoading(on) {
  el("auth-submit").disabled = on;
  el("auth-submit").textContent = on
    ? (mode === "login" ? "Signing in…" : "Creating…")
    : (mode === "login" ? "Sign in" : "Create account");
}

function renderAuthScreen() {
  const remembered = loadRememberedUser();
  const fullEl = el("auth-full");
  const rememberedEl = el("auth-remembered");
  if (remembered?.username) {
    rememberedEl.classList.remove("hidden");
    fullEl.classList.add("hidden");
    const av = el("auth-remembered-avatar");
    if (remembered.avatarUrl) {
      av.style.backgroundImage = `url("${String(remembered.avatarUrl).replace(/"/g, '\\"')}")`;
      av.style.background = "";
      av.textContent = "";
    } else {
      av.style.backgroundImage = "";
      av.style.background = "linear-gradient(135deg, var(--accent), var(--accent-2))";
      av.textContent = (remembered.username[0] || "?").toUpperCase();
    }
    el("auth-remembered-name").textContent = "@" + remembered.username;
    el("auth-remembered-error").textContent = "";
    el("auth-remembered-password").value = "";
    setTimeout(() => el("auth-remembered-password").focus(), 50);
  } else {
    rememberedEl.classList.add("hidden");
    fullEl.classList.remove("hidden");
  }
}

export function initAuthUI() {
  document.querySelectorAll(".auth-tab").forEach((t) =>
    t.addEventListener("click", () => setMode(t.dataset.mode))
  );

  el("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = el("auth-username").value.trim();
    const password = el("auth-password").value;
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      setError("Username must be 3–20 chars (letters, numbers, underscore).");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setError("");
    setLoading(true);
    try {
      const email = usernameToEmail(username);
      if (mode === "signup") {
        if (await isUsernameTaken(username)) {
          throw new Error("That username is already taken.");
        }
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await registerUsername(username, cred.user.uid);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setError(prettyAuthError(err));
    } finally {
      setLoading(false);
    }
  });

  // Remembered-profile submit
  el("auth-remembered-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const remembered = loadRememberedUser();
    if (!remembered) return;
    const password = el("auth-remembered-password").value;
    if (password.length < 6) {
      el("auth-remembered-error").textContent = "Password must be at least 6 characters.";
      return;
    }
    el("auth-remembered-error").textContent = "";
    const submitBtn = e.target.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    submitBtn.textContent = "Signing in…";
    try {
      await signInWithEmailAndPassword(auth, usernameToEmail(remembered.username), password);
    } catch (err) {
      el("auth-remembered-error").textContent = prettyAuthError(err);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Sign in";
    }
  });

  // Switch-account: clear the remembered profile and show the full sign-in form.
  el("auth-switch-account").addEventListener("click", () => {
    clearRememberedUser();
    renderAuthScreen();
  });

  renderAuthScreen();
}

function prettyAuthError(err) {
  const code = err?.code || "";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Wrong username or password.";
  }
  if (code.includes("email-already-in-use")) return "That username is already taken.";
  if (code.includes("weak-password")) return "Password is too weak.";
  if (code.includes("network")) return "Network error. Check your connection.";
  return err?.message?.replace(/^Firebase: /, "") || "Something went wrong.";
}

export function watchAuth(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      // Show the remembered profile (if any) the next time the auth screen renders.
      renderAuthScreen();
      callback(null);
      return;
    }
    const profile = await loadUser(user.uid).catch(() => null);
    const u = {
      uid: user.uid,
      email: user.email,
      username: profile?.username || (user.email || "").split("@")[0],
      profile: profile?.profile || {}
    };
    rememberUser(u);
    callback(u);
  });
}

export async function doSignOut() {
  await signOut(auth);
}
