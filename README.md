# Tank CTF

A one-button online capture-the-flag game for friends. Every player has a single button: tap to
shoot (and reverse your turn), hold to walk. Built with Next.js, a Colyseus game server and a
shared TypeScript game simulation.

## Run it locally
```bash
npm install
npm run dev          # web app on http://localhost:3000
npm run dev:server   # game server on ws://localhost:2567
```

- `/` — home page (online rooms arrive in phase 2).
- `/play` — solo practice against spinning targets.
- `/dev/sprites` — dev-only preview of the art, drawn large.

## Checks
```bash
npm test -w shared   # game rules
npm run typecheck    # all three packages
```

## Layout
| Folder | What it is |
|---|---|
| `shared/` | Game rules: map, physics, the 60 Hz simulation step, constants. Runs on server and client. |
| `server/` | Colyseus server. Runs the simulation for each room and sends snapshots to players. |
| `web/` | Next.js app: pages, canvas renderer, one-button input, mobile TAP button. |
| `docs/GAMEPLAY.md` | How the game plays, with every tuning number. |
| `PLAN.md` | Decisions, phases and status. |
