// /app/auth.js
import { app } from "./state.js";

/**
 * Auth goals:
 * - Always have a stable actor id (uid) via anonymous auth by default
 * - Optional Google login (upgrades identity)
 * - Persistence so you don't re-log every time
 */

export async function initAuth() {
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

      // If no user yet, sign in anonymously so we always have request.auth.uid
      if (!user) {
        try {
          await app.auth.signInAnonymously();
          // onAuthStateChanged will fire again with the anon user
          return;
        } catch (e) {
          console.error("Anonymous sign-in failed:", e);
        }
      }

      resolve(app.user);
    });
  });

  return app.authReady;
}

export function getActorId() {
  // Always prefer auth uid (anon or google)
  return app.user?.uid || null;
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
