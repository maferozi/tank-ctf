# Tank CTF — plan and status

Web version of the one-button tank mini game from "2 3 4 Player Games", rebuilt as an online
capture-the-flag game for friends, with voice chat. Own art, map and name; no assets copied.
Gameplay details and tuning numbers live in [docs/GAMEPLAY.md](docs/GAMEPLAY.md).

## Decisions
- Lobby: up to 8 players, join with a room code and a name (no login).
- Mode (v1): team CTF, Red vs Blue, one flag per team. No auto-balancing: teams are picked by hand
  (uneven sizes allowed) and stay fixed for the whole match.
- Devices: touch, mouse and keyboard. Desktop: click anywhere or Space. Phones/tablets: a big
  TAP button outside the map (only that button counts).
- Clean game screen: no HUD panels. Only ammo dots and power time bars under your own soldier.
- Voice: open mic with a mute button, LiveKit Cloud free tier (check limits before relying on it).
- Latency: tune later, once deployed. Target ping under 100 ms; client prediction for your own
  soldier comes after the first online version works.

## Lobby and teams (phase 3)
- Host creates the lobby and gets a room code; players join with the code and a name.
- Lobby shows two columns, Red and Blue. Players pick a slot; the host can move people.
- The match can't start until both teams have at least one player. When it starts, teams lock.
- A player who disconnects can rejoin into the same team.
- Leave / Back to lobby buttons are designed here (a "Leave match?" confirm during play).

## CTF rules (phase 4)
- Touch the enemy flag to pick it up; the carrier is slower. Reach your own base to score.
- A killed carrier drops the flag; touching your own dropped flag returns it.
- First to 3 captures, or highest score when the timer ends. Respawn time likely 3–5 s.
- Maps are designed after these rules exist (base and flag placement drives the layout).

## Architecture
- `shared/`: the game rules. A deterministic 60 Hz step (state + inputs -> state) used by the
  solo practice mode, the server, and later client prediction.
- `server/`: Colyseus. Server-authoritative: runs the shared sim, receives button down/up,
  broadcasts snapshots. Rooms are addressed by a short code.
- `web/`: Next.js App Router. Canvas 2D renderer (no game engine), interpolates between states.
- Hosting: web on Vercel; Colyseus on Fly.io or Railway near the players (Vercel can't hold
  WebSockets); LiveKit Cloud for voice.

## Status
- Phase 0 done: monorepo (npm workspaces), Next.js 16, Colyseus 0.18, shared sim package.
- Phase 1 done (solo practice at `/play`): one-button controls, walls, bullets with range,
  6-round magazine, kills and respawn, weight-based pushing, movable crates, power-up boxes
  (shield, speed, flare), top-down soldier art with fallen bodies, mobile TAP button.
  37 sim tests.
- Phase 2 done (online): create a room on `/`, share the 4-letter code or `/room/CODE` link,
  up to 8 players on one map. The server runs the shared sim at 60 Hz from per-tick button
  samples and broadcasts 30 Hz snapshots; clients predict their own soldier and show others
  ~100 ms behind (see `docs/NETCODE.md`). Players pick Red or
  Blue when joining (temporary until the phase 3 lobby). Name tags over soldiers, yours in gold.
  The join form shows each team's players live (`GET /rooms/CODE` on the game server), so
  you can see the teams before picking one. Two-bot smoke test: `npm run smoke -w server`.

- Phase 4 core done (capture the flag): flags at each base, pick up / carry / drop / return /
  auto-return, carrier at 0.8× speed, capture wins the round with a banner and a fresh round
  after 6 s. Bodies now slide with momentum when shot while walking. See `docs/GAMEPLAY.md`.
  Match types: single match (one capture wins) or a tournament of 5 or 7 rounds, 2 points per
  round won, all rounds played, most points wins. Picked when creating a room, along with a
  map for each round from 4 maps (Arena, Crossfire, Fortress, Canyon) shown as preview cards.
  Still open: a round timer, if wanted.

- Phase 3 done (lobby): rooms open in a lobby with Red and Blue lists. Players switch their own
  team; the host (★, the creator, passed on if they leave) moves players and starts once both
  teams have someone. Teams lock during the match; late joiners go straight onto their team.
  In-game Leave button with a confirm. A dropped player (refresh, network blip) keeps their seat
  and soldier for 30 s and rejoins automatically. After the match everyone returns to the lobby.

## Deployed (31 Oct 2026)
- Web: Vercel project `tank-ctf` (team "asad's projects"), https://tank-ctf.vercel.app, root
  directory `web`, auto-deploys on push to `main`. Env: `NEXT_PUBLIC_SERVER_URL` =
  `wss://tank-ctf-server-jd5n.onrender.com` (Production).
- Game server: Render web service `tank-ctf-server`, Singapore, Free plan, from `main`
  (`npm ci` / `npm start`, Node 22, health check `/health`), auto-deploys on push. Sleeps after
  15 min idle (~1 min to wake). `render.yaml` documents the same settings.
- Live test from Lahore: smoke test passes; 8 bots: 60 ticks/s, 0 state mismatches, press to
  shot ~130 ms median, snapshot gap p99 ~105 ms (real-network jitter).

- Maps and look (31 Oct 2026): light theme everywhere. Three maps recreated from the original
  app's layouts (Classroom, Garden, Crossroads) with scoring pads separate from the flag stands,
  water that blocks walking but not bullets, desks, and per-map floor art (wood, grass, tiles).

## Known gaps after phase 2
- 8-player load test passed (see `docs/NETCODE.md`): steady 60 Hz server, 30 Hz snapshots, no
  hitches, identical state for all.
- Input delay fixed with client prediction: your own soldier reacts in ~5–18 ms (was ~120 ms
  on the same machine, ~220 ms at a 100 ms round trip). Other players are still shown ~100 ms
  behind for smoothness.
- Snapshots send the full state as JSON-like messages (~a few KB each). Fine for 8 players on
  a LAN or one server region; trim fields if bandwidth becomes a problem.
- A refresh or dropped connection loses your soldier (rejoin with the link). Reconnect is phase 3.
- No Leave button in a match yet (browser back works). Comes with the phase 3 lobby.

## Build order
1. Solo prototype. Done.
2. Online: rooms by code, everyone on one map, server decides state. Done.
3. Lobby and teams: Red/Blue lists, host starts, teams lock, Leave button, rejoin. Done.
4. Capture the flag: flags, bases, scoring, timer, win screen.
5. Voice chat: LiveKit room per lobby, mute, speaking indicators.
6. Maps and art: more maps, floor and prop art, sounds. (4 maps exist; see docs/GAMEPLAY.md.)
7. Deploy, playtest with friends, tune latency and feel. Deployed; playtesting next.

## Cautions
- Mic needs HTTPS and a user click to start. Players need headphones to avoid echo.
- Vercel cannot hold WebSockets, so the game server must be hosted elsewhere.
