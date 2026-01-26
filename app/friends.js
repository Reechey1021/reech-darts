// app/friends.js
// Friends (Phase 1): friend requests + friends list.

// Data model (stored on each user document):
//   friends: { [uid]: { uid, displayName, photoURL, since } }
//   friendRequests: {
//     incoming: { [uid]: { uid, displayName, photoURL, sentAt } },
//     outgoing: { [uid]: { uid, displayName, photoURL, sentAt } },
//   }

function safeObj(x) {
  return x && typeof x === "object" ? x : {};
}

function ensureFriendShape(userDoc) {
  const u = safeObj(userDoc);
  const friends = safeObj(u.friends);
  const fr = safeObj(u.friendRequests);
  return {
    friends,
    friendRequests: {
      incoming: safeObj(fr.incoming),
      outgoing: safeObj(fr.outgoing),
    },
  };
}

export function getFriendState(myProfile, otherUid) {
  if (!otherUid) return "none";
  const me = ensureFriendShape(myProfile);
  if (myProfile?.uid && myProfile.uid === otherUid) return "self";
  if (me.friends?.[otherUid]) return "friends";
  if (me.friendRequests?.incoming?.[otherUid]) return "incoming";
  if (me.friendRequests?.outgoing?.[otherUid]) return "outgoing";
  return "none";
}

// -----------------------------
// Subcollection-based Friends (Phase 1)
// -----------------------------
// We keep the old map-based helpers above for backward compatibility,
// but the Friends module now uses subcollections:
//   /users/{uid}/friendRequestsIncoming/{fromUid}
//   /users/{uid}/friendRequestsOutgoing/{toUid}
//   /users/{uid}/friends/{friendUid}

export async function getFriendStateDb(db, myUid, otherUid) {
  if (!db || !myUid || !otherUid) return "none";
  if (myUid === otherUid) return "self";

  const meRef = db.collection("users").doc(myUid);
  const friendsRef = meRef.collection("friends").doc(otherUid);
  const incomingRef = meRef.collection("friendRequestsIncoming").doc(otherUid);
  const outgoingRef = meRef.collection("friendRequestsOutgoing").doc(otherUid);

  const [fSnap, inSnap, outSnap] = await Promise.all([
    friendsRef.get(),
    incomingRef.get(),
    outgoingRef.get(),
  ]);

  if (fSnap.exists) return "friends";
  if (inSnap.exists) return "incoming";
  if (outSnap.exists) return "outgoing";
  return "none";
}

function makeMiniIdentity(uid, docData) {
  const d = safeObj(docData);
  return {
    uid,
    displayName: String(d.displayName || d.nickname || "Player"),
    photoURL: d.photoURL || d.photoUrl || d.photo || null,
  };
}

export async function sendFriendRequest(db, fromUid, toUid) {
  if (!db || !fromUid || !toUid || fromUid === toUid) return;

  const fromUserRef = db.collection("users").doc(fromUid);
  const toUserRef = db.collection("users").doc(toUid);

  const fromOutgoingRef = fromUserRef.collection("friendRequestsOutgoing").doc(toUid);
  const toIncomingRef = toUserRef.collection("friendRequestsIncoming").doc(fromUid);

  await db.runTransaction(async (tx) => {
    // Only read what the sender is allowed to read:
    const [fromSnap, toSnap, existingOut] = await Promise.all([
      tx.get(fromUserRef),     // allowed (own doc)
      tx.get(toUserRef),       // allowed (profiles are readable by signed-in users)
      tx.get(fromOutgoingRef), // allowed (own subcollection)
    ]);

    if (!fromSnap.exists || !toSnap.exists) return;

    // If we already sent a request, do nothing
    if (existingOut.exists) return;

    const fromId = makeMiniIdentity(fromUid, fromSnap.data());
    const toId = makeMiniIdentity(toUid, toSnap.data());
    const sentAt = Date.now();

    // Write sender outgoing
    tx.set(fromOutgoingRef, {
      ...toId,
      uid: toUid,
      sentAt,
      createdAt: new Date(),
    });

    // Write recipient incoming (allowed because create rule checks request.auth.uid == fromUid)
    tx.set(toIncomingRef, {
      ...fromId,
      uid: fromUid,
      sentAt,
      createdAt: new Date(),
    });
  });
}



export async function cancelFriendRequest(db, myUid, otherUid) {
  if (!db || !myUid || !otherUid || myUid === otherUid) return;

  const meUserRef = db.collection("users").doc(myUid);
  const otherUserRef = db.collection("users").doc(otherUid);

  const meOutgoingRef = meUserRef.collection("friendRequestsOutgoing").doc(otherUid);
  const otherIncomingRef = otherUserRef.collection("friendRequestsIncoming").doc(myUid);

  await db.runTransaction(async (tx) => {
    const outSnap = await tx.get(meOutgoingRef);
    if (!outSnap.exists) return;
    tx.delete(meOutgoingRef);
    // best-effort cleanup; requires rules allowing sender delete on recipient incoming
    tx.delete(otherIncomingRef);
  });
}


export async function acceptFriendRequest(db, myUid, otherUid) {
  if (!db || !myUid || !otherUid || myUid === otherUid) return;

  const meUserRef = db.collection("users").doc(myUid);
  const otherUserRef = db.collection("users").doc(otherUid);

  const meIncomingRef = meUserRef.collection("friendRequestsIncoming").doc(otherUid);
  const otherOutgoingRef = otherUserRef.collection("friendRequestsOutgoing").doc(myUid);

  const meFriendRef = meUserRef.collection("friends").doc(otherUid);
  const otherFriendRef = otherUserRef.collection("friends").doc(myUid);

  await db.runTransaction(async (tx) => {
    // Reads the acceptor is allowed to perform: own incoming + both user profiles.
    const [meSnap, otherSnap, incomingSnap] = await Promise.all([
      tx.get(meUserRef),
      tx.get(otherUserRef),
      tx.get(meIncomingRef),
    ]);
    if (!meSnap.exists || !otherSnap.exists) return;
    if (!incomingSnap.exists) return; // nothing to accept

    const meId = makeMiniIdentity(myUid, meSnap.data());
    const otherId = makeMiniIdentity(otherUid, otherSnap.data());
    const since = Date.now();

    // Create friends on both sides
    tx.set(meFriendRef, { ...otherId, uid: otherUid, since, createdAt: new Date() });
    tx.set(otherFriendRef, { ...meId, uid: myUid, since, createdAt: new Date() });

    // Delete request docs both sides (otherOutgoing may require a rule that allows recipient deletion)
    tx.delete(meIncomingRef);
    tx.delete(otherOutgoingRef);
  });
}

export async function declineFriendRequest(db, myUid, otherUid) {
  if (!db || !myUid || !otherUid || myUid === otherUid) return;

  const meUserRef = db.collection("users").doc(myUid);
  const otherUserRef = db.collection("users").doc(otherUid);

  const meIncomingRef = meUserRef.collection("friendRequestsIncoming").doc(otherUid);
  const otherOutgoingRef = otherUserRef.collection("friendRequestsOutgoing").doc(myUid);

  await db.runTransaction(async (tx) => {
    const incomingSnap = await tx.get(meIncomingRef);
    if (!incomingSnap.exists) return;
    tx.delete(meIncomingRef);
    tx.delete(otherOutgoingRef);
  });
}

export async function removeFriend(db, myUid, otherUid) {
  if (!db || !myUid || !otherUid || myUid === otherUid) return;

  const meUserRef = db.collection("users").doc(myUid);
  const otherUserRef = db.collection("users").doc(otherUid);

  const meFriendRef = meUserRef.collection("friends").doc(otherUid);
  const otherFriendRef = otherUserRef.collection("friends").doc(myUid);

  await db.runTransaction(async (tx) => {
    const meFriendSnap = await tx.get(meFriendRef);
    if (!meFriendSnap.exists) return;
    tx.delete(meFriendRef);
    tx.delete(otherFriendRef);
  });
}


// -----------------------------
// GAME INVITES (Phase 2)
// Stored as: /users/{toUid}/gameInvites/{inviteId}
// -----------------------------

export async function sendGameInvite(db, fromUid, toUid, gameId, meta = {}) {
  if (!db || !fromUid || !toUid || !gameId) return;
  if (fromUid === toUid) return;

  const inviteId = `${fromUid}_${gameId}`;
  const ref = db.collection("users").doc(toUid).collection("gameInvites").doc(inviteId);

  const payload = {
    status: "pending",
    createdAt: Date.now(),
    gameId,
    fromUid,
    fromName: meta.fromName || meta.displayName || "Player",
    fromPhotoURL: meta.fromPhotoURL || meta.photoURL || null,
  };

  await ref.set(payload, { merge: true });
  return inviteId;
}

export async function respondToGameInvite(db, myUid, inviteId, status) {
  if (!db || !myUid || !inviteId) return;
  const ref = db.collection("users").doc(myUid).collection("gameInvites").doc(inviteId);
  await ref.set({ status: String(status || "declined"), respondedAt: Date.now() }, { merge: true });
}

export function listenForGameInvites(db, myUid, onInvites) {
  if (!db || !myUid || typeof onInvites !== "function") return () => {};
  const col = db.collection("users").doc(myUid).collection("gameInvites");
  return col.orderBy("createdAt", "desc").limit(5).onSnapshot(
    (snap) => {
      const docs = [];
      snap.forEach((d) => docs.push({ id: d.id, ...(d.data() || {}) }));
      onInvites(docs);
    },
    (err) => console.warn("Invite listener error", err)
  );
}
