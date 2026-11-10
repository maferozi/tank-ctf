# Tank CTF

A one-button online capture-the-flag game for up to 8 friends. Every player has a single
button: **tap** to shoot (and reverse your turn), **hold** to walk. Two teams, Red and Blue,
try to steal each other's flag and carry it home. Built with Next.js, a Colyseus game server
and a shared TypeScript game simulation that runs on both the server and every player's device.

## Features
- **One-button controls.** Your soldier turns on the spot; every press fires and reverses the
  turn, holding walks forward. Rapid taps fire in a straight line. 6-round magazine, one round
  back every 1.5 s.
- **Capture the flag.** Grab the enemy flag (it rides on your back, you walk a bit slower) and
  carry it into your own base. Shoot a carrier and the flag drops; teammates return it by touch,
  or it goes home by itself after 15 s.
- **Single match or tournament.** One capture wins a single match. Tournaments have 5 or 7
  rounds, 2 points per round won, every round is played, and most points wins.
- **7 maps, picked per round.** Arena, Crossfire, Fortress, Canyon, Classroom (desks), Garden
  (house and pool) and Crossroads, shown as preview cards when creating a room. All but Arena
  are exactly symmetric. On Classroom, Garden and Crossroads you score on your team's pad.
- **Physics.** Soldiers, crates, power boxes and fallen bodies have weight and push each other.
  Soldiers shot while walking slide forward as they fall. Bodies are cover for their own team.
- **Power-ups.** Purple "?" boxes give a shield, a speed boost or a flare (4-way bursts), one at
  a time, 14 s each.
- **Online play.** Create a room, share the 4-letter code or link; the join page shows who is on
  each team. In the lobby players pick sides, the host can move people, and starts the match;
  teams lock until it ends. Reloading or a dropped connection rejoins you within 30 s. The
  server runs the game; your own soldier is predicted on your device, so controls react within
  a frame or two even with a 100 ms connection.
- **Voice chat.** Open mic with a mute chip, peer to peer and encrypted: everyone in the lobby,
  only your own team during a match. Speaking players glow. See [docs/VOICE.md](docs/VOICE.md).
- **Phones and desktop.** Desktop: click anywhere or press Space. Phones: a big TAP button next
  to the map.

How it all plays, with every tuning number: [docs/GAMEPLAY.md](docs/GAMEPLAY.md).

## Play it
**https://tank-ctf.vercel.app**: create a room and send friends the link. The website is on
Vercel; the game server runs always-on on AWS in Mumbai (`wss://15-206-64-146.sslip.io`).
Website changes deploy on push; the game server is updated with `deploy/aws/deploy.sh`.

## Run it locally
Needs Node.js 22+.

```bash
npm install
npm run dev          # web app on http://localhost:3000
npm run dev:server   # game server on ws://localhost:2567
```

Both must be running to play online.

| Page | What it is |
|---|---|
| `/` | Pick a name, team, match type and maps; create a room or join one by code. |
| `/room/CODE` | A room. Share this link: it shows the match type, maps and teams, then joins the lobby. |
| `/play` | Solo practice against spinning targets. `/play?map=garden` practises on a given map. |
| `/dev/sprites` | Dev only: the art drawn large, for reviewing graphics. |

### Playing with friends on the same Wi-Fi
Not tested yet. The web app connects to the game server on the same host it was loaded from,
port 2567, so friends should be able to open `http://<your-computer's-LAN-IP>:3000` if your
firewall allows ports 3000 and 2567. The Next.js dev server may also need that IP listed in
`allowedDevOrigins` in `web/next.config.ts`. For a deployed server, set `NEXT_PUBLIC_SERVER_URL`
(see `web/.env.example`).

## Checks
```bash
npm test -w shared          # game rules, prediction, flags, matches and maps (80 tests)
npm run typecheck           # all three packages
npm run smoke -w server     # two bots play against a running server
npm run loadtest -w server  # 8 bots for 20 s: sync, latency and bandwidth report
```

Dev helpers: start the server with `TICK_STATS=1` to log tick cost, or `COLYSEUS_LATENCY=100`
to simulate a 100 ms round trip; open a room with `?server=ws://localhost:<port>` to point
the browser at another server; `window.__net` in the console shows prediction stats.

## How it's built
| Folder | What it is |
|---|---|
| `shared/` | The game rules: maps, physics, flags, matches, the 60 Hz simulation step, prediction, constants. Runs on the server and in the browser. |
| `server/` | Colyseus server: one room per match, runs the simulation, applies one input per player per tick, sends 30 Hz snapshots. |
| `web/src/game/` | Game screen, Canvas 2D renderer, one-button input, solo and online drivers. |
| `web/src/net/` | Connection to the server, home menu with match and map pickers, room and join pages. |
| `docs/GAMEPLAY.md` | How the game plays, with every tuning number. |
| `docs/NETCODE.md` | How online sync and prediction work, load-test results, what latency players feel. |
| `PLAN.md` | Decisions, phases and status. |

## Status
Done: solo prototype, online rooms, client prediction, capture the flag, match types, map
selection and the lobby. Next: voice chat, more maps and art, and deploying it so friends can
play from their phones. See
[PLAN.md](PLAN.md).
