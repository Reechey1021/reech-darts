# Arcade Bull Challenge – Architecture & Runtime Wiring (handover doc)

This document describes how the current darts **Arcade → Bull Challenge** experience is wired in this ZIP, based on the code as it exists now.

It is written to support “chat-to-chat handover”: you can paste sections of this doc into a new chat and we can keep working without re-discovering the structure.

---

## 1) Entry points & routing

### Key pages
- **Dashboard**: `/dashboard/` (root navigation to Arcade)
- **Arcade lobby list**: `/arcade/` (select game type/mode)
- **Arcade play (Bull Challenge)**: `/arcade/play/?game=<GAME_ID>`
  - HTML: `arcade/play/index.html`
  - Runtime: `arcade/play/arcadeMain.js`

### How the play page boots
`arcade/play/arcadeMain.js` exports/defines a top-level `main()` which:
1. Applies theme + build tag.
2. Initializes Firebase + auth (`initFirebase()`, `initAuth({ autoAnonymous: true })`).
3. Reads the `game` query string param and sets:
   - `app.gameId`
   - `app.gameRef = db.collection("games").doc(gameId)`
4. Hooks UI subsystems (Audits/Chat, Ready Room, Settings, toasts, etc.)
5. Subscribes to live game state:
   - `ref.onSnapshot(...)`
6. Wires button handlers (keypad, submit, undo, leave, restart, overlay undo, etc.)

---

## 2) Game document shape (Firestore)

### Location
- `games/<GAME_ID>` is the single doc representing the lobby + match + arcade state.

### High-level fields used by Arcade
The code reads/writes these areas frequently:

- `match`
  - `lobbyType` or similar online indicator (helper `isOnlineGame(state)` abstracts this)
  - `seat1Id`, `seat2Id` (or `seat1Id`/`seat2Id` on root in some older states)
  - `seat1Name`, `seat2Name`
  - `seat1PhotoURL`, `seat2PhotoURL`
  - `allowMutualControl` (Boolean; `false` means Mutual Control OFF)
  - `arcade`
    - `started` (Boolean)
    - `visitsLimit` (Number, default 10)
    - `suddenDeath` (Boolean)
    - `seat2EverFilled` (Boolean; once true, Ready Room invite tools never return)
    - `bcState` (Bull Challenge state; see below)

- `readyRoom`
  - `ready` (map of `{ [actorId]: boolean }`)
  - `updatedAt`
  - `setup` (small metadata; the code keeps this present for UI parity)

---

## 3) Bull Challenge state model (`match.arcade.bcState`)

The Bull Challenge state is stored inside the game doc at:

- `match.arcade.bcState`

The code normalizes this through `ensureBullChallengeState(state)` and expects:

- `players`: array length 2
  - each: `{ score, bulls, outers, misses }`
- `history`: array of submitted visits, newest last
  - each entry typically includes:
    - `player` (0 or 1)
    - `hits` (array of 3 strings like `"bull" | "outer" | "miss"`)
    - any derived counts/scoring
- `visitsTaken`: `[v0, v1]`
- `currentPlayer`: `0 | 1`
- `visitsLimit` and `effectiveLimit` (Numbers)
- `finished` (Boolean)
- `winner`: `0 | 1 | null`

**Pending darts** are NOT written to Firestore; they are local UI state and only become persistent when you “Submit Visit”.

---

## 4) Turn control + Mutual Control rules (critical)

### Definitions
- **Online game**: `isOnlineGame(state) === true`
- **Mutual Control OFF**: `state.match.allowMutualControl === false`
- **Actor ID**: `getActorId()` (current authenticated player identity)
- **Seat mapping**: `seatIds(state)` returns seat1/seat2 ids; your seat index is derived by comparing actorId to seat ids.

### Input gating
The render loop computes:
- `allowInput = canActNow(state, bc) && joinedOk && startedOk && !bc.finished`

In online mode, it also requires seat2 to be present (`joinedOk`) before allowing input (unless local).

### Undo behavior (exact)
Undo has **two different implementations** depending on the mode:

1) **Main Undo button** (`#bcUndoBtn`)
   - Visible and active when:
     - local OR
     - online AND Mutual Control is ON
   - Hidden when:
     - online AND Mutual Control is OFF

2) **Turn overlay Undo** (`#overlayUndoBtn` inside `#turnOverlay`)
   - Only relevant when:
     - online AND Mutual Control is OFF
   - Overlay shows only to the **non-active** player (it is “your opponent’s turn” overlay)
   - The red Undo appears only when:
     - overlay is showing AND
     - the last history entry belongs to **you** (so you can undo your last submitted visit *after your turn has passed*).
   - Clicking it calls `undoBullVisitTurnOnly(ref)` which only undoes your last visit.

---

## 5) Ready Room (online pre-start) – rules & wiring

### Purpose
Ready Room is a modal shown while:
- online game AND
- not started

It displays:
- Seat 1 card (“HOST”) with Ready/Not Ready badge
- Seat 2 card (“GUEST”) OR empty placeholder
- Ready/Unready button (for current actor)
- Start button for host (enabled only when both ready)

### Invite tools – exact UX rule
Invite/copy/friends tools are inside the **P2 area** and are governed by:

- Show only if:
  - you are the host (seat1 actor)
  - seat2 is empty
  - `match.arcade.seat2EverFilled` is **not** true
- Once seat2 has ever been filled, a transaction sets:
  - `match.arcade.seat2EverFilled = true`
- After that, the invite tools never return, even if seat2 later leaves.

The invite link is:
- `/arcade/play/?game=<GAME_ID>`

### Friends invite modal
- Reads friends from:
  - `users/<myUid>/friends` (Firestore subcollection)
- Uses `doc.id` as the friend UID (important)
- Name fallback:
  - `name || displayName || username || handle || "Friend"`
- Invites send payload including:
  - `fromName` (so the recipient doesn’t see “Player”)
  - `fromPhotoURL`
  - `mode: "arcade"`

---

## 6) Join/leave toast + sounds (online)

On each snapshot, the code compares previous seat ids with current seat ids:

- If seat2 transitions `null → <id>`:
  - show join toast + play `audio/sounds/LobbyJoin.mp3`
- If seat2 transitions `<id> → null`:
  - show leave toast + play `audio/sounds/LobbyLeave.mp3`
- If seat1 transitions `<id> → null`:
  - show leave toast as well

Toast DOM:
- `#seatJoinToast`, `#seatJoinToastText`

---

## 7) Game Settings menu (in-match)

Game Settings is a modal on `/arcade/play/` that reuses IDs from `/game/` so the existing “Audits / Restart / Leave / etc.” UI can be reused.

Key IDs:
- `#gameSettingsBtn` → opens `#gameSettingsModal`
- `#gsCloseBtn` → closes modal
- `#gsNewGameBtn` → opens the correct local/online setup modal depending on lobby type
- `#gsRestartGameBtn` → confirm restart flow
- `#gsLeaveMatchBtn` → confirm leave flow
- `#gsOpenAuditChatBtn` → opens audits/chat panel

Setup modals:
- `#arcadeSetupLocalModal`
- `#arcadeSetupOnlineModal`

---

## 8) “Dead button” failure mode (what to check first)

If multiple buttons stop responding at once, the first thing to check is:

- **DevTools Console → red SyntaxError**.

A single parse-time JS error in `arcadeMain.js` prevents all later wiring from running (making the UI look “randomly dead”).

Quick checklist:
1. Open `/arcade/play/?game=...`
2. Console should have **no SyntaxError**
3. If a button is dead, search for:
   - missing/renamed DOM id
   - the event listener being inside a block that never executes
   - a runtime exception earlier in `main()` that aborts wiring

---

## 9) Where to patch safely next time

If you’re making changes in future chats, these are the “safe seams”:

- **Ready Room rendering rules**: `renderReadyRoom(state)`
- **Bull Challenge UI render**: `render(state)` (purely DOM updates)
- **Mutations to game state**:
  - `submitBullVisit(ref, hits)`
  - `undoBullVisit(ref)`
  - `undoBullVisitTurnOnly(ref)`
  - `restartMatch(ref)`
  - `tryClaimSeat2(state)`
  - `maybeAutoStartFromReady(ref, state)`
- **Settings menu wiring**: the “Game Settings menu” section inside `main()`

---

## 10) Glossary

- **Visit**: one turn of 3 darts (Bull/Outer/Miss)
- **History**: persistent list of submitted visits
- **Mutual Control**: when ON, both players can control shared actions like Undo
- **Turn overlay**: UI overlay shown to the non-active player when Mutual Control is OFF

