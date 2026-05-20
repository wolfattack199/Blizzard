// Auth UI: drives sign-in/sign-up and resolves to a Firebase-backed user.
import {
  auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  usernameToEmail,
  registerUsername,
  loadUser
} from "./firebase.js";

let mode = "login";
let loading = false;
let pendingSignup = null;

const LAST_USER_KEY = "blizzard.lastUser";

function el(id) {
  return document.getElementById(id);
}

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
  if (loading) return;
  mode = next === "signup" ? "signup" : "login";

  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });

  el("auth-submit").textContent = mode === "login" ? "Sign in" : "Create account";
  el("auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  el("auth-confirm-wrap").classList.toggle("hidden", mode !== "signup");
  el("auth-confirm-password").required = mode === "signup";
  el("auth-confirm-password").value = "";
  setError("");
}

function setError(msg) {
  el("auth-error").textContent = msg || "";
}

function setLoading(on) {
  loading = on;
  el("auth-submit").disabled = on;
  el("auth-submit").classList.toggle("loading", on);
  el("auth-submit").textContent = on
    ? (mode === "login" ? "Signing in..." : "Creating account...")
    : (mode === "login" ? "Sign in" : "Create account");

  ["auth-username", "auth-password", "auth-confirm-password"].forEach((id) => {
    const field = el(id);
    if (field) field.disabled = on;
  });
  document.querySelectorAll(".auth-tab").forEach((tab) => { tab.disabled = on; });
}

function renderAuthScreen() {
  const remembered = loadRememberedUser();
  const fullView = el("auth-full");
  const rememberedView = el("auth-remembered");

  if (remembered?.username) {
    rememberedView.classList.remove("hidden");
    fullView.classList.add("hidden");

    const avatar = el("auth-remembered-avatar");
    if (remembered.avatarUrl) {
      const safeUrl = String(remembered.avatarUrl).replace(/"/g, '\\"');
      avatar.style.backgroundImage = `url("${safeUrl}")`;
      avatar.style.backgroundSize = "cover";
      avatar.style.backgroundPosition = "center";
      avatar.textContent = "";
    } else {
      avatar.style.backgroundImage = "";
      avatar.style.backgroundSize = "";
      avatar.style.backgroundPosition = "";
      avatar.style.background = "linear-gradient(135deg, var(--accent), var(--accent-2))";
      avatar.textContent = (remembered.username[0] || "?").toUpperCase();
    }

    el("auth-remembered-name").textContent = "@" + remembered.username;
    el("auth-remembered-username").value = remembered.username;
    el("auth-remembered-error").textContent = "";
    el("auth-remembered-password").value = "";
    setTimeout(() => el("auth-remembered-password").focus(), 50);
    return;
  }

  rememberedView.classList.add("hidden");
  fullView.classList.remove("hidden");
  setTimeout(() => el("auth-username").focus(), 50);
}

export function initAuthUI() {
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });

  el("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = el("auth-username").value.trim();
    const password = el("auth-password").value;
    const confirmPassword = el("auth-confirm-password").value;

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      setError("Username must be 3-20 chars (letters, numbers, underscore).");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (mode === "signup" && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const email = usernameToEmail(username);
      if (mode === "signup") {
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        await finishSignup(username, cred.user.uid);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      setError(prettyAuthError(err));
    } finally {
      setLoading(false);
    }
  });

  el("auth-remembered-form").addEventListener("submit", async (event) => {
    event.preventDefault();

    const remembered = loadRememberedUser();
    if (!remembered) return;

    const password = el("auth-remembered-password").value;
    if (password.length < 6) {
      el("auth-remembered-error").textContent = "Password must be at least 6 characters.";
      return;
    }

    const submit = event.target.querySelector("button[type='submit']");
    el("auth-remembered-error").textContent = "";
    submit.disabled = true;
    submit.textContent = "Signing in...";

    try {
      await signInWithEmailAndPassword(auth, usernameToEmail(remembered.username), password);
    } catch (err) {
      el("auth-remembered-error").textContent = prettyAuthError(err);
    } finally {
      submit.disabled = false;
      submit.textContent = "Sign in";
    }
  });

  el("auth-switch-account").addEventListener("click", () => {
    clearRememberedUser();
    setMode("login");
    renderAuthScreen();
  });

  setMode("login");
  renderAuthScreen();
}

async function finishSignup(username, uid) {
  const profile = { username, profile: { bio: "" } };
  const promise = registerUsername(username, uid);
  pendingSignup = { uid, profile, promise };

  try {
    await promise;
  } catch (err) {
    await signOut(auth).catch(() => {});
    throw err;
  } finally {
    if (pendingSignup?.uid === uid) pendingSignup = null;
  }
}

function prettyAuthError(err) {
  const code = err?.code || "";
  const message = String(err?.message || "");

  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "Wrong username or password.";
  }
  if (code.includes("email-already-in-use") || message.includes("already taken")) {
    return "That username is already taken.";
  }
  if (code.includes("weak-password")) return "Password is too weak.";
  if (code.includes("too-many-requests")) return "Too many attempts. Please wait a moment and try again.";
  if (code.includes("operation-not-allowed")) return "Email/password sign-in is not enabled for this Firebase project.";
  if (code.includes("network")) return "Network error. Check your connection.";
  if (code.includes("permission-denied") || message.includes("PERMISSION_DENIED")) {
    return "Firebase database rules blocked profile setup. Check SECURITY.md and try again.";
  }

  return message.replace(/^Firebase: /, "") || "Something went wrong.";
}

export function watchAuth(callback) {
  return onAuthStateChanged(auth, async (user) => {
    if (!user) {
      renderAuthScreen();
      callback(null);
      return;
    }

    const pending = pendingSignup?.uid === user.uid ? pendingSignup : null;
    if (pending) {
      try {
        await pending.promise;
      } catch {
        callback(null);
        return;
      }
    }

    const profile = await loadUser(user.uid).catch(() => pending?.profile || null);
    const signedInUser = {
      uid: user.uid,
      email: user.email,
      username: profile?.username || (user.email || "").split("@")[0],
      profile: profile?.profile || {}
    };

    rememberUser(signedInUser);
    callback(signedInUser);
  });
}

export async function doSignOut() {
  await signOut(auth);
}
