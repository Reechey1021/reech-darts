# Changelog – reech-darts-arcade-seg1-fix1 → seg2-fix1

## Segment 2 (Online ATC parity)
### Arcade Play (`arcade/play/arcadeMain.js`)
- Online nameRow population: `seat1Name/seat2Name` + avatars now use the same fallbacks as Ready Room (`match.*` and `lobby.host/joiner`) so Guest identity reliably shows after Ready Room.
- Turn overlay parity for ATC: uses the same overlay logic as Bull Challenge (strict turns when Mutual Control is OFF), including the overlay Undo button visibility rules.

## Arcade Play (`arcade/play/arcadeMain.js`)
- Fixed parse-time syntax error in Invite Friends modal loader by removing two stray closing lines.
- Removed the `openInvite=1` query param auto-open flow on `/arcade/play/` (no post-start invite popup behavior).
- Removed unused invite popup wiring and its auto-open logic; Ready Room invite tools remain.
- Added an `inviteUrl()` helper dedicated to Ready Room invite tools.
- Fixed `Game Settings` button wiring to avoid TDZ/ReferenceError by declaring `gameSettingsBtn` before use.
- (Small) Ensured Ready Room invite link text can be initialized via the helper.

## Notes
- No functional changes were made to the already-implemented:
  - Mutual Control OFF overlay undo behavior
  - seat2EverFilled “invite tools disappear forever” behavior
  - join/leave toast + sounds logic
  - friends list UID/name fallback logic
