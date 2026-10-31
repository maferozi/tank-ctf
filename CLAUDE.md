# Tank CTF

Online one-button capture-the-flag game for Asad and friends. Personal project.
Read `PLAN.md` (decisions, phases, status) and `docs/GAMEPLAY.md` (rules and numbers) first.

## How it's built
- npm workspaces: `shared/` (game rules), `server/` (Colyseus 0.18), `web/` (Next.js 16, App Router).
- `shared/src/sim.ts` is the single source of truth for gameplay. It must stay deterministic
  (no `Math.random`, no wall-clock time): the server runs it, and clients will run it for
  prediction. Randomness goes through the seeded `state.rng`.
- All tuning numbers live in `shared/src/constants.ts`.
- `web/src/game/render.ts` draws everything with Canvas 2D; there is no game engine.
- Online: `shared/src/net.ts` defines the messages. `server/src/GameRoom.ts` runs the sim and
  broadcasts snapshots; `web/src/game/onlineDriver.ts` sends button changes and interpolates
  snapshots; `web/src/net/session.ts` keeps the live room across page navigation.
  `GameScreen` draws frames from either driver (`soloDriver` for `/play`).
- After changing server or net code, run the server and `npm run smoke -w server`.
- Some fields still say "tank" (`Tank`, `TANK_RADIUS`, `addTank`) from before the soldier art.
  The player is drawn as a soldier; the names were kept to avoid churn.
- TypeScript 7 needs `"types": ["node"]` in tsconfigs that use Node APIs.

## Working rules
- Run `npm test -w shared` and `npm run typecheck` after gameplay changes. Add a sim test for
  every rule change.
- Gameplay changes come from Asad's playtesting; keep his numbers exactly and say what changed.
- Keep the game screen clean: no HUD panels unless asked.
- Personal repo: commit as `Muhammad Asad Ferozi <maferozi373@gmail.com>` (set in the repo's
  git config). No remote yet; ask before creating one or pushing.
