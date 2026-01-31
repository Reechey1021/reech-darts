// /app/auth.js
import { app } from "./state.js";
import { getGuestDisplayName } from "./profile.js";
import { ensureUserProfile, getMyDisplayName } from "./userProfile.js";

/**
 * Auth goals:
 * - Always have a stable actor id (uid) via anonymous auth by default
 * - Optional Google login (upgrades identity)
 * - Persistence so you don't re-log every time
 */

// Options:
// - autoAnonymous: if true, sign in anonymously if there is no existing session.
//   Use this on gameplay pages where Firestore rules expect request.auth.uid.
//   Keep it false on landing/dashboard so we don't create anon accounts unnecessarily.
export async function initAuth({ autoAnonymous = false } = {}) {
  if (!firebase?.auth) {
    console.error("Firebase Auth SDK missing. Did you add firebase-auth-compat.js?");
    return;
  }

  app.auth = firebase.auth();

  // Persist session (prevents constant re-login)
  try {
    await app.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
  } catch (e) {
    console.warn("Auth persistence failed:", e);
  }
  // Track user in app state
  app.authReady = new Promise((resolve) => {
    app.auth.onAuthStateChanged(async (user) => {
      app.user = user || null;
      app.userProfile = null;

      // If no user yet, optionally sign in anonymously so we always have request.auth.uid
      if (!user && autoAnonymous) {
        try {
          await app.auth.signInAnonymously();
          // onAuthStateChanged will fire again with the anon user
          return;
        } catch (e) {
          console.error("Anonymous sign-in failed:", e);
        }
      }

      // If signed in with Google (non-anonymous), ensure a profile doc exists.
      if (app.user && !app.user.isAnonymous) {
        try {
          app.userProfile = await ensureUserProfile();
        } catch (e) {
          console.warn("ensureUserProfile failed:", e);
        }
      }

      resolve(app.user);
    });
  });

  return app.authReady;
}

// Ensure we have *some* Firebase auth user (anonymous is fine).
// Useful for guest flow + any Firestore rules keyed on request.auth.uid.
export async function ensureAnonymousSignIn() {
  if (app.user) return app.user;
  if (!app.auth) app.auth = firebase.auth();

  try {
    const cred = await app.auth.signInAnonymously();
    app.user = cred.user;
    return app.user;
  } catch (err) {
    console.error("Anonymous sign-in failed:", err);
    throw err;
  }
}

// Call this right before you need an actor id (creating/joining a game)
// and you don't care whether the user is anonymous vs Google.
export async function ensureSignedInAnonymously() {
  if (!app.auth) return null;
  if (app.user?.uid) return app.user;
  try {
    const cred = await app.auth.signInAnonymously();
    app.user = cred.user;
    return cred.user;
  } catch (e) {
    console.error("Anonymous sign-in failed:", e);
    return null;
  }
}

export function getActorId() {
  // Prefer Firebase uid (anon or Google); fallback to stable device id.
  return app.user?.uid || app.deviceId;
}

export function getActorName() {
  // For Google users: use profile displayName (Settings nickname) if set.
  if (app.user && !app.user.isAnonymous) {
    return getMyDisplayName();
  }
  // For guests (anon): use guest name (localStorage) if set.
  return getGuestDisplayName() || "Guest";
}


export async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();

  // IMPORTANT:
  // We intentionally use POPUP auth for static hosting (e.g., GitHub Pages).
  // Redirect auth relies on the Firebase Hosting helper endpoint:
  //   https://<authDomain>/__/firebase/init.json
  // which is not available unless you are actually serving the app from Firebase Hosting.
  //
  // Popup auth avoids the /__/auth/handler flow entirely and works on GitHub Pages
  // as long as the domain is added in Firebase Auth → Authorized domains.

  try {
    await app.auth.signInWithPopup(provider);
  } catch (e) {
    console.error("Google sign-in failed:", e);
    // Common causes:
    // - Popup blocked by browser
    // - Third-party cookies / tracking protection blocking the auth session
    // - Domain not authorized in Firebase console
    const msg = e?.message || String(e);
    alert(
      [
        "Google sign-in failed.",
        "",
        "If you blocked popups, allow popups for this site and try again.",
        "Also verify your domain is in Firebase Auth → Settings → Authorized domains.",
        "",
        msg,
      ].join("\n")
    );
    throw e;
  }
}

export async function signOutUser() {
  if (!app.auth) return;

  // Prevent "auto-resume" loops after sign-out.
  try {
    localStorage.setItem("justSignedOut", "1");
    localStorage.removeItem("lastNemesisGameId");
    localStorage.removeItem("nemesisPendingGameId");
    localStorage.removeItem("startOfflineOnLoad");
  } catch (_) {}

  await app.auth.signOut();
}
// Simple helper for pages (like dashboard) that just want an auth listener.
export function onUserChanged(cb) {
  if (!app.auth) app.auth = firebase.auth();
  return app.auth.onAuthStateChanged(cb);
}
