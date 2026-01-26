# Reech Darts — Smoke Test Checklist (Stage 0)

Run this quick checklist after each feature stage to catch regressions early.

## Core (local)
- [ ] Open app (no `?game=`) → landing loads, no errors in console.
- [ ] Play Offline → Setup → start match → submit 3 turns.
- [ ] Undo last turn works and restores scores + current player correctly.
- [ ] Restart match works.
- [ ] Leave match returns to lobby/landing as expected.

## Core (online)
- [ ] Host creates online game → copy invite link.
- [ ] Joiner opens invite link → seat 2 can be claimed.
- [ ] Turn enforcement: non-active player cannot submit score.
- [ ] Undo respects permissions (only allowed when appropriate).

## Bull start (if enabled)
- [ ] Bull throw modal appears, both players can enter throws.
- [ ] Winner selected, match starts, and audio sync plays on both clients.

## Checkout / end-of-leg
- [ ] Checkout to 0 triggers checkout confirmation flow (current V3 behavior).
- [ ] Confirming checkout ends leg and increments match scoreline.
- [ ] End-of-match winner modal appears when best-of reached.

## Dashboard
- [ ] Google sign-in works.
- [ ] Stats load without errors.
- [ ] Theme toggle on dashboard still works.
- [ ] Returning from dashboard to a game works.

## Notes
- Record any console errors (copy/paste) when reporting bugs.
- Verify the build tag shows the expected version (bottom-left).
