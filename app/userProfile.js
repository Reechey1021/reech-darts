// app/userProfile.js
// Firestore-backed user profiles for Google-auth users.

import { app } from "./state.js";

function usersRef(db) {
  return db.collection("users");
}

export async function ensureUserProfile() {
  if (!app.db || !app.user) return null;

  const uid = app.user.uid;
  const ref = usersRef(app.db).doc(uid);
  const snap = await ref.get();

  if (!snap.exists) {
    const displayName = (app.user.displayName || app.user.email || "Player").trim();
    const base = {
      displayName,
      equipment: "",
      createdAt: new Date(),
      updatedAt: new Date(),
      openAuditChatByDefault: false,
      // Friends (Phase 1)
      friends: {}, // map of uid -> { uid, displayName, photoURL, since }
      friendRequests: {
        incoming: {}, // map of uid -> { uid, displayName, photoURL, sentAt }
        outgoing: {}, // map of uid -> { uid, displayName, photoURL, sentAt }
      },
      stats: {
        matches: 0,
        wins: 0,
        losses: 0,
        legsWon: 0,
        legsLost: 0,
        highestScore: 0,
        avg3DA: 0,
        avgF9D: 0,
        hundredPlus: 0,
        oneFortyPlus: 0,
        oneEighty: 0,
        // counts darts thrown in ALL modes (casual + )
        lifetimeDarts: 0,
      },
      recent: [], // last 5: "W"/"L"
    };
    await ref.set(base);
    app.userProfile = base;
    return base;
  }

  const data = snap.data();
  app.userProfile = data;
  return data;
}

export async function loadUserProfile(uid) {
  if (!app.db || !uid) return null;
  const ref = usersRef(app.db).doc(uid);
  const snap = await ref.get();
  return snap.exists ? snap.data() : null;
}

export async function updateMyProfile(fields) {
  if (!app.db || !app.user) return;
  const uid = app.user.uid;
  const ref = usersRef(app.db).doc(uid);
  const patch = { ...fields, updatedAt: new Date() };
  await ref.set(patch, { merge: true });
  // refresh cached copy
  const snap = await ref.get();
  app.userProfile = snap.exists ? snap.data() : app.userProfile;
}

export function getMyDisplayName() {
  // Prefer saved profile displayName, then guest name, then auth profile, then fallback.
  if (app.userProfile?.displayName) return String(app.userProfile.displayName);
  if (app.guestDisplayName) return String(app.guestDisplayName);
  if (app.user?.displayName) return String(app.user.displayName);
  return "Player";
}
