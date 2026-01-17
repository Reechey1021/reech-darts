// /app/auth.js
import { app } from "./state.js";
import { getEffectiveDisplayName } from "./profile.js";
import { ensureUserProfile } from "./userProfile.js";

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
  // Always prefer auth uid (anon or google)
  return app.user?.uid || null;
}

export function getActorName() {
  // Uses: signed-in user's display name OR guest name from localStorage
  return getEffectiveDisplayName(app.user);
}


export async function signInWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();

  // Popup works on desktop; on iOS/Safari it can be flaky — fallback to redirect if popup fails.
  try {
    await app.auth.signInWithPopup(provider);
  } catch (e) {
    console.warn("Popup sign-in failed, trying redirect:", e?.message || e);
    await app.auth.signInWithRedirect(provider);
  }
}

export async function signOutUser() {
  if (!app.auth) return;
  await app.auth.signOut();
}

// Simple helper for pages (like dashboard) that just want an auth listener.
export function onUserChanged(cb) {
  if (!app.auth) app.auth = firebase.auth();
  return app.auth.onAuthStateChanged(cb);
}
