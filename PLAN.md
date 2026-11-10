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
- Voice: open mic with a mute button, peer-to-peer WebRTC between players' browsers (no media
  server), signaling through the game room, Cloudflare TURN (or our own coturn) for strict
  networks. Lobby: everyone hears everyone; match: your own team only. See docs/VOICE.md.
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
  WebSockets). Voice is peer to peer; the game server only relays signaling and hands out
  STUN/TURN config.

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

## Deployed (updated 9 Nov 2026)
- Web: Vercel project `tank-ctf` (team "asad's projects"), https://tank-ctf.vercel.app, root
  directory `web`, auto-deploys on push to `main`. Env: `NEXT_PUBLIC_SERVER_URL` =
  `wss://15-206-64-146.sslip.io` (Production; changing it needs a redeploy).
- Game server (since 9 Nov 2026): AWS EC2 `tank-ctf-server`, Mumbai (ap-south-1), t3.micro,
  Ubuntu 26.04, Elastic IP 15.206.64.146, on the AWS free plan's credits. Always on (no sleep).
  Caddy serves HTTPS/WSS at `15-206-64-146.sslip.io` with an automatic Let's Encrypt
  certificate and forwards to the game server (systemd service `tank-ctf`, port 2567).
  **Not auto-deployed:** after pushing, run `deploy/aws/deploy.sh` (ships the committed HEAD,
  installs server deps, restarts). SSH key `~/.ssh/tank-ctf-aws`; SSH is allowed only from
  Asad's two home IPs (221.120.215.10, 119.63.130.154), so update the security group
  `launch-wizard-1` if those change. Optional voice TURN keys go in `/etc/tank-ctf.env` on the
  server (not set yet). See `deploy/aws/`.
- Measured from Lahore, 4 bots: press to shot seen 93 ms median on AWS Mumbai vs 151 ms on
  Render Singapore; worst snapshot gap 51 ms vs 316 ms.
- Old game server, kept as a backup for now: Render web service `tank-ctf-server`, Singapore,
  Free plan, still auto-deploys from `main` (`render.yaml`). Sleeps after 15 min idle. The
  website no longer uses it; delete it once AWS has proven itself.
- Live test from Lahore: smoke test passes; 8 bots: 60 ticks/s, 0 state mismatches, press to
  shot ~130 ms median, snapshot gap p99 ~105 ms (real-network jitter).

- Sound effects (31 Oct 2026): synthesized with Web Audio for shots, flares, kills, shields,
  powers, flags and rounds, panned by position; Sound on/off button in game. See docs/GAMEPLAY.md.
- Feel matched to the original (2 Nov 2026): turn speed, walk speed (with a short speed-up),
  bullet speed and range measured frame by frame from screen recordings; unlimited ammo, quick
  shots fan out instead of snapping into one line, crates break when shot. Numbers and method in
  docs/ORIGINAL.md; pending Asad's playtest. Maps at the original's 1.41:1 shape are next.
- Maps at 26 x 18 (5 Nov 2026): all 9 maps rebuilt at the original's ~1.41:1 shape (1040 x 720 px),
  every one exactly fair. New: Office (desks, washroom corridors) and Open Field. New legend:
  `D` desk (heavy, pushable, stops bullets, never breaks), `*` bush (decoration only). Map tests
  now also check cover near each flag, power boxes away from flags and no dead ends.
- Pushing fixed (5 Nov 2026): a soldier pushes a crate, desk, bed or power box straight along
  the face it walks into, even off centre, and grips it (`PUSH_GRIP` 0.6), instead of the box
  skidding round its corner. Asad's report: "its corner moved around but not moved forward".
- Power-ups at random times (5 Nov 2026): boxes start each round hidden, appear after 5–15 s
  and come back 15–30 s after being taken, rolled with the seeded rng. Shield now stops 3
  bullets or lasts 10 s (was every bullet for 14 s), so a shielded carrier can be stopped.
- Smaller flags and bases (5 Nov 2026): `FLAG_RADIUS` 10 → 6, `BASE_RADIUS` 34 → 20; you take a
  flag by reaching it and score by standing on your stand, and both are drawn at those sizes.
- Netcode rework (10 Nov 2026): gameplay over a UDP WebRTC data channel (inputs repeated until
  acked, snapshots as deltas against the client's last acked state, events resent until acked),
  WebSocket fallback. At 1-5% packet loss: no freeze over 100 ms (WebSocket: 0.45-1.7 s), every
  tap fires. Server applies every input sample exactly once in order (late input pauses that
  soldier, a backlog catches up 2 per tick): 0% of shots fire off the player's screen heading
  (was 22-25% on jittery links). Aim sent with presses, lag compensation to 500 ms, hit zone
  18 px. Compiled server build, docs/DEPLOY.md for AWS (t3.small, Elastic IP, UDP 40000-40100),
  voice 16 kbps in matches and paused while the game connection struggles.
- Hits and collisions online (9 Nov 2026): lag compensation (shots checked against enemies as
  the shooter saw them, up to 250 ms back), swept bullet hits, nearby players drawn at their
  present position so soldiers don't seem to walk through each other; beds bigger (108 px,
  12 px gaps, too narrow to slip between); an empty-magazine tap reverses the turn again (Asad).
- Rules and voice option (9 Nov 2026, players' calls): shield 5 hits; 2 s spawn protection
  after a respawn; a flag carrier is slowed by 0.8x on top of any speed boost (1.28x boosted); you can only score while your own
  flag is home; soldier collision radius 14 → 12 (matches the drawn body, fits narrow gaps) with
  a slimmer "you" ring; each player can share their voice with the other team (Team only /
  Both teams chip next to the mic, default Team only); blocks turn when pushed off-centre.
- Spray, flicker and lag (9 Nov 2026): fast tapping fires every tap (bounce guard 100 → 66 ms),
  taps that can't fire don't flip the gun, bursts stay within 12° of their first shot, a finger
  tap never walks (hold 60 → 100 ms), dry click on an empty magazine, second-finger taps count.
  No more flicker at round and match restarts (frames drawn from the server state while a
  round is over). Other players carry on through a late snapshot for up to 120 ms. Server input
  buffer adapts to each player's jitter and never loses a tap. Docker tests show Render Free
  (~0.1 CPU) can't keep 60 Hz; at 0.5 CPU the game is smooth (see docs/NETCODE.md).
- Crates stay solid (5 Nov 2026, players' call): `CRATE_BREAKS` off so crates can be pushed to
  block lanes. Desks and beds never break either.
- New look (5 Nov 2026): every sprite redrawn in a top-down cartoon style with dark outlines
  (soldiers with helmets and rifles, bullets with team-coloured streaks and impact bits, crates,
  desks, beds, bubbles for shields, glows for carriers, fallen-soldier poses), themed map floors
  cached as one layer, and effects for every event (`web/src/game/effects.ts`). Art lives in
  `web/src/game/art/`, `mapArt.ts` and `render.ts`; no image assets. Menus and lobby in a dark
  "modern mobile game" style with glassy panels, glowing buttons and team cards.
- Phone landscape screen (5 Nov 2026): the map fills the screen height with one round TAP
  button in the corner; chips beside the map; phones held upright see "Turn your phone";
  fullscreen chip with landscape lock; installable as an app (manifest, fullscreen, landscape).
  Desktop: click or Space anywhere. Sharpness capped at 2x.
- Netcode (5 Nov 2026): keyframes every 2 s plus lossless deltas, ~0.62 KB per snapshot
  (was 3.2 KB), ~18.7 KB/s per player with 8. Smoothing delay for other players adapts to
  measured jitter (starts at 130 ms, 70–200 ms). Fewer allocations per frame. See docs/NETCODE.md.
- Respawn squares (31 Oct 2026): every map has a 2 x 2 respawn square per team where soldiers
  start each round and respawn; teams score at their own flag stand on every map.
- Maps and look (31 Oct 2026): light theme everywhere. Three maps recreated from the original
  app's layouts (Classroom, Garden, Crossroads) with scoring pads separate from the flag stands,
  water that blocks walking but not bullets, desks, and per-map floor art (wood, grass, tiles).
- Look (31 Oct 2026): cartoon game style. Sky-blue striped background, white panels with thick
  ink outlines and hard shadows, chunky press-down buttons, Lilita One (titles, buttons, in-game
  banners) and Nunito (text). Room code shown as letter tiles in the lobby. Walls drawn as
  raised blocks; Arena has a sand floor with teal walls. Solo practice has a Menu chip.

- Voice chat (5 Nov 2026): peer-to-peer WebRTC audio, always encrypted (DTLS-SRTP), no media
  server. Lobby: everyone hears everyone; match: own team only, re-connected automatically when
  the phase or teams change. The server relays signaling (`MSG.voice`) only within a voice group,
  stamps the sender, size- and rate-limits it, and hands out ICE config: STUN always, Cloudflare
  TURN or our own coturn (per-player expiring credentials from a shared secret) from env
  (`server/.env` locally, `/etc/tank-ctf.env` on the AWS server). Speech-tuned Opus (mono,
  28 kbps cap, FEC, DTX). Mic starts on the first tap in the room; mute chip in lobby and game
  (remembered), speaking glow on lobby rows and a ring on in-game name tags, one-time
  "use headphones" hint. Colyseus' 4 KB message limit raised to 20 KB for SDPs. Tested in Chrome
  with 3 players (lobby mesh, team split in the match, mute, leave). Needs a TURN key set on
  the game server for players on strict networks; a real-phone test is next. See docs/VOICE.md.
- Voice fixes after review (5 Nov 2026): self-hosted TURN now uses coturn's shared-secret REST
  credentials (`TURN_SECRET`; a fixed password would be handed to anyone in a room); connections
  that never come up are restarted after a deadline; a peer can force a fresh connection at most
  every 3 s; taps unlock audio on finger-up and keep listening until playback runs ("Tap to
  hear" on the chip when it doesn't); a browser without WebRTC shows "No voice" instead of
  freezing the room; one ICE refresh timer; config requests rate-limited; back/forward cache
  pages hang up instead of killing voice; the headphones hint is remembered once shown.

## Known gaps after phase 2
- 8-player load test passed (see `docs/NETCODE.md`): steady 60 Hz server, 30 Hz snapshots, no
  hitches, identical state for all.
- Input delay fixed with client prediction: your own soldier reacts in ~5–18 ms (was ~120 ms
  on the same machine, ~220 ms at a 100 ms round trip). Other players are still shown ~100 ms
  behind for smoothness.
- Snapshots are keyframes plus deltas since 5 Nov 2026 (~0.62 KB each, was ~3.2 KB).
- A refresh or dropped connection loses your soldier (rejoin with the link). Reconnect is phase 3.
- No Leave button in a match yet (browser back works). Comes with the phase 3 lobby.

## Build order
1. Solo prototype. Done.
2. Online: rooms by code, everyone on one map, server decides state. Done.
3. Lobby and teams: Red/Blue lists, host starts, teams lock, Leave button, rejoin. Done.
4. Capture the flag: flags, bases, scoring, timer, win screen.
5. Voice chat: peer-to-peer WebRTC, lobby-wide then team-only, mute, speaking indicators. Done
   (5 Nov 2026); TURN key and phone playtest pending.
6. Maps and art: more maps, floor and prop art, sounds. (9 maps exist; see docs/GAMEPLAY.md.)
7. Deploy, playtest with friends, tune latency and feel. Deployed; playtesting next.

## Cautions
- Mic needs HTTPS and a user click to start. Players need headphones to avoid echo.
- Vercel cannot hold WebSockets, so the game server must be hosted elsewhere.
