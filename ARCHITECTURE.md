# Reech Darts – Architecture Notes (living doc)

This file is intended as a quick orientation so a fresh chat can regain context fast.

## High-level
- The app supports **Default** (classic darts: X01, etc.) and **Arcade** (self-contained mini-games).
- Arcade was intentionally implemented as a **separate rules envelope** so new games don’t disturb the base game.

## Key concepts
### Match object
- `match.rules.preset` distinguishes rule presets (e.g. `"default"` vs `"arcade"`).
- Arcade-specific configuration lives under:
  - `match.arcade.mode` – which arcade game is active (e.g. `"bull_challenge"`, `"around_the_clock"`)
  - `match.arcade.<gameCfg>` – small config blob for the game (e.g. `match.arcade.atc`)

### Arcade play pattern (important)
- Arcade games buffer **3 dart inputs locally** and only write to Firestore when the player hits **Submit Visit**.
- This keeps turn resolution atomic and consistent for online play.
- Pending darts are kept client-side (not synced per dart).

## Current Arcade games
### Bull Challenge (implemented)
- Uses Arcade envelope and buffered 3-dart visits.
- Has its own keypad and submit logic.

### Around the Clock (in progress)
- **Phase 1:** Singles only (`S{target}` + `Miss`), start on 1 or 20, predictive keypad, buffered 3 darts, temporary finish condition.
- **Phase 2:** Adds **Multipliers ON/OFF**.
  - If multipliers ON: keypad shows `S/D/T/Miss` and advances by 1/2/3.
  - If OFF: keypad shows `S/Miss` only.
- ATC config:
  - `match.arcade.atc.startOn` (1 or 20)
  - `match.arcade.atc.multipliers` (boolean)
- ATC runtime state:
  - `match.arcade.atcState` holds the per-player targets and history.

## Files to know
- `/arcade/` – arcade landing + match creation
- `/arcade/play/` – arcade game runtime page (renders Bull / ATC based on `match.arcade.mode`)
- `/arcade.js` – arcade lobby creation + initial match shape
- `/arcade/play/arcadeMain.js` – in-game UI, buffered input, submit/undo logic for arcade games

## In-game settings (Arcade)
- The in-game **Game Settings** menu is wired in `arcade/play/arcadeMain.js`.
- **New Game** re-opens the setup modal for the current arcade mode (Bull or ATC).
  - For ATC, the setup modal also exposes `startOn` and `multipliers`.
- **Restart Game** resets the current mode's state (clears history + resets targets/scores) without leaving the lobby.
- **Change Gamemode** can switch between Bull Challenge and Around the Clock.
