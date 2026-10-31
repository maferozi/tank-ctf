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

- `/` — pick a name and team, then create a room or join one by its 4-letter code.
- `/room/CODE` — a room. Share this link; opening it asks for a name and team, then joins.
- `/play` — solo practice against spinning targets.
- `/dev/sprites` — dev-only preview of the art, drawn large.

Both servers must be running to play online.

### Playing with friends on the same Wi-Fi
Not tested yet. The web app connects to the game server on the same host it was loaded from,
port 2567, so friends should be able to open `http://<your-computer's-LAN-IP>:3000` if your
firewall allows ports 3000 and 2567. The Next.js dev server may also need that IP listed in
`allowedDevOrigins` in `web/next.config.ts`. For a deployed server, set `NEXT_PUBLIC_SERVER_URL`
(see `web/.env.example`).

## Checks
```bash
npm test -w shared          # game rules
npm run typecheck           # all three packages
npm run smoke -w server     # two bots play a round against a running server
```

## Layout
| Folder | What it is |
|---|---|
| `shared/` | Game rules: map, physics, the 60 Hz simulation step, constants. Runs on server and client. |
| `server/` | Colyseus server. Runs the simulation for each room and sends snapshots to players. |
| `web/src/game/` | Game screen, canvas renderer, one-button input, solo and online drivers. |
| `web/src/net/` | Connection to the server, home menu, room page and join form. |
| `docs/GAMEPLAY.md` | How the game plays, with every tuning number. |
| `PLAN.md` | Decisions, phases and status. |
