# Voice chat

Open-mic voice chat between players, built into the room. Added 5 Nov 2026.

## Who hears whom
- **Lobby:** everyone in the room hears everyone.
- **Match:** you only hear your own team. When the match starts, voice connections to the other
  team are hung up; when everyone is back in the lobby they connect again. All of this happens
  by itself whenever the phase or the teams change.
- **Sharing with the other team (each player's own choice):** the chip next to the mic says
  **Team only** (default) or **Both teams**. With Both teams, the other team hears you during
  the match too. It's one way: sharing your voice never lets you hear an enemy who didn't
  share theirs (your browser sends that enemy silence, theirs sends you nothing), and two
  players who both share talk both ways. It can be switched any time, also mid-match
  (`Player.shareVoice`, `MSG.shareVoice`; rules `canHear` / `canVoice` in `shared/src/voice.ts`;
  the server relays signaling only where either side may hear the other).
- A player whose connection dropped (shown as "away") is left out until they are back.

## How it works
- **Peer to peer.** Audio goes straight between players' browsers over WebRTC, one connection per
  pair of players who can hear each other (with 4 players on a team, 3 connections each). There is
  no media server, ours or anyone else's.
- **Always encrypted.** WebRTC encrypts all audio end to end (DTLS-SRTP), including when it passes
  through a TURN relay: the relay forwards encrypted packets it can't read.
- **Signaling through the game room.** To set up a connection the two browsers swap a few small
  messages (an SDP offer and answer, ICE candidates). These go over the existing Colyseus
  connection as `MSG.voice` (`shared/src/voice.ts`, `VoiceMessage`). The server
  (`server/src/GameRoom.ts`, `relayVoice`):
  - passes a message on only between two players who are in the same voice group right now
    (`canVoice`: same room in the lobby, same team in a match);
  - stamps `from` itself, so nobody can pretend to be someone else;
  - drops messages over 16 KB (`MAX_VOICE_MESSAGE_BYTES`) and anything malformed;
  - rate-limits each player (a burst of 300, enough to connect to 7 players at once with all their
    ICE candidates, then 40 a second; ICE config requests: 5, then one per 10 s). Clients pace
    their own signaling to 60 messages a second, offers, answers and byes ahead of ICE
    candidates: Colyseus cuts any client sending over 240 messages a second (game input
    included, `maxMessagesPerSecond`), and an answer stuck behind candidates would be late;
  - never sees or touches audio.
- **The group rule is one pure function** (`voiceGroup`, `voicePeers`, `canVoice` in
  `shared/src/voice.ts`), used by the server to relay and by the client to decide whom to
  connect to. Unit tests: `shared/src/voice.test.ts`. Server relay rules: `npm run smoke -w server`.
- **Client** (`web/src/net/voice.ts`), owned by the room session (`session.ts`), so it keeps
  running from the lobby into the match and back:
  - **Mic** starts on your first tap, click or key press in the room (browsers need a gesture),
    never on page load, with echo cancellation, noise suppression and auto gain, mono. The tap on
    "Create room" or "Join" counts (while the browser still treats it as a fresh gesture,
    `navigator.userActivation.isActive`), so the mic normally comes on in the lobby, not with the
    first tap of a match. If the mic is denied or missing you still hear everyone ("Mic
    blocked"; tap the chip to try again).
  - **Light first tap:** the tap itself only asks for the mic (`getUserMedia`, async) and resumes
    playback. The AudioContext and the speaking meters are built afterwards, when the main thread
    is idle (`requestIdleCallback`, at most 1 s later), so turning voice on can't stall a frame.
    Browsers let that context run (Chrome: the page has had a tap; Safari: the mic is open); if it
    starts suspended anyway, the next tap resumes it.
  - **Connections** use the "perfect negotiation" pattern. In each pair the player with the higher
    id is polite; the other one starts the connection, and on a clash the polite side gives way.
    Every connection has a number (`epoch`, set by the side that starts it), so messages for an
    old connection (after a reload, say) are ignored and a newer one replaces it. A polite side
    that gets no offer within 2.5 s asks the other side to start over (`bye`). The other side can
    make you replace a connection (a newer epoch, or a `bye`) at most once every 3 s; more is
    ignored, so a misbehaving player can't make your browser churn through connections.
  - **Recovery:** a connection that fails, or stays "disconnected" for 4 s, restarts ICE (up to
    twice), then starts fresh. Every connection also has a deadline: not up after 12 s (a lost
    offer or answer, ICE that never finishes), it starts over from scratch (the polite side 4 s
    later, by hanging up). The deadline doubles with each miss in a row, up to 60 s.
  - **If the browser can't do WebRTC** (no WebRTC, turned off, or it rejects the ICE config),
    voice switches off for the room ("No voice" on the chip) and the game carries on.
  - **Speech-tuned Opus:** mono, at most 28 kbps in the lobby and 16 kbps during a match
    (`RTCRtpSender.setParameters`, changed on each connection when the room's phase changes, no
    renegotiation; the SDP's `maxaveragebitrate` asks the other side for at most 28), in-band FEC on (hides lost packets), DTX on (next to nothing is sent
    while you're quiet), written into each side's SDP (`tuneOpusSdp`).
  - **Playback** through one `<audio>` element per player, kept for that player across
    reconnects. If the browser refuses to play (autoplay rules; iOS Safari when your mic is off),
    the chip says "Tap to hear" and the next tap anywhere starts it. Taps are listened for on
    finger-up (`pointerup`, `touchend`, `click`; a touch `pointerdown` doesn't count as a gesture)
    and the listeners stay until playback really runs; they come back when iOS suspends audio
    (a call, the home screen). A tap on the mic chip also resumes playback.
  - **Speaking indicators:** an `AnalyserNode` per stream, read 10 times a second into buffers
    allocated once. `voice.speaking` is a set of player ids that changes in place;
    `voice.subscribe()` tells React only when someone starts or stops talking.
  - **Leaving** the room or closing the page stops the mic (`track.stop()`) and closes every
    connection. A page kept in the back/forward cache hangs up and stops the mic too; when you go
    back to it, voice starts again from your next tap.
- **On screen:** a mic chip in the lobby (top right) and in a match (beside the room chip):
  mic off (before your first tap), connecting (only while the first try is under way; a player
  who can't be reached doesn't keep it there), on (green, glows while you talk), muted, paused
  (see `setGameStress` below), blocked,
  "Tap to hear", "No voice".
  Tap to mute or unmute; mute is remembered on the device. Lobby rows glow green while that
  player talks; in a match a green ring pulses round a talking teammate's name tag (drawn on the
  canvas; the renderer only reads the speaking set, nothing is added per frame). The first tap
  shows "Use headphones to avoid echo" once (dismissible, remembered).

## Game first: `setGameStress`
Voice must never make a struggling game connection worse. `session.voice.setGameStress(true)`
stops sending your mic to everyone (`replaceTrack(null)` on every sender; connections stay up
and you keep hearing everyone); `setGameStress(false)` puts it back. Only changes do anything, so
the netcode can call it every frame with its current verdict (late snapshots, a reconnect).
While paused the chip says "Mic paused" (muted look) and you don't glow as speaking;
`voice.paused` is true and `window.__voice.paused` shows it in dev (try it from the console
with `__voiceChat.setGameStress(true)`, dev builds only). Nothing calls it yet: the
netcode will.

## Data use
Opus at up to 28 kbps in the lobby and 16 kbps in a match, near zero in silence. In a full lobby of 8 you send your voice to 7
players: at most about 200 kbps up and down while everyone talks, much less in practice. In a
match only your teammates (at most 3 with 4 per team).

## ICE servers (STUN and TURN)
Browsers need help to find a path to each other. The game server hands every client its ICE
config (`MSG.voiceConfig`, on join and when asked; clients ask again before credentials expire),
built from env in `server/src/ice.ts`:
- **STUN, always:** `stun:stun.l.google.com:19302` and `stun:stun.cloudflare.com:3478`. Enough
  for most home and mobile networks (direct connections).
- **TURN** relays audio for players whose network blocks direct connections (some mobile
  carriers, offices, schools). Without it those players can't hear or be heard; everyone else is
  fine. The client's dev stats say "relay not configured" when there is none.

### Environment variables
Set them on Render (dashboard, Environment; `render.yaml` lists them with `sync: false`) or, for
local runs, in `server/.env` (loaded at startup if present; git-ignored, see
`server/.env.example`). Real environment variables win over the file.

| Variable | What |
| --- | --- |
| `CLOUDFLARE_TURN_KEY_ID` | Cloudflare TURN key ID |
| `CLOUDFLARE_TURN_API_TOKEN` | That key's API token |
| `TURN_URLS` | Self-hosted TURN (coturn), comma separated, e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp`. Entries that aren't `stun:`/`turn:`/`turns:` URLs are dropped (one bad URL would make browsers refuse the whole config). |
| `TURN_SECRET` | coturn's `static-auth-secret` (see below) |

Cloudflare is used when both of its variables are set; otherwise the self-hosted TURN when both
of its variables are set; otherwise STUN only.

### Self-hosted TURN (coturn)
Every player has to be given some TURN credential, and rooms need no login, so anything handed
out can be read by anyone who joins a room. A fixed username and password would therefore turn
the server into an open relay for good; `TURN_USERNAME`/`TURN_CREDENTIAL` are not supported (the
server warns and ignores them). Instead coturn runs with its "TURN REST API" shared secret:

```
use-auth-secret
static-auth-secret=<long random string, same as TURN_SECRET>
realm=turn.example.com
```

The game server makes a credential per player, valid for 24 h: username
`<expiry unix time>:<player id>`, password `base64(HMAC-SHA1(TURN_SECRET, username))`. coturn
checks both itself. The secret never leaves the game server; clients ask for a fresh credential
every 6 h.

### Creating a Cloudflare TURN key
1. Sign in to the Cloudflare dashboard (a free account is fine).
2. Go to **Realtime** (Calls) > **TURN Server** > **Create** (name it e.g. "tank-ctf").
3. Copy the **Turn Token ID** into `CLOUDFLARE_TURN_KEY_ID` and the **API Token** into
   `CLOUDFLARE_TURN_API_TOKEN`. The token is shown once.
4. Restart the game server. It logs `voice: Cloudflare TURN credentials ready`.

The server asks Cloudflare for short-lived credentials
(`POST https://rtc.live.cloudflare.com/v1/turn/keys/{KEY_ID}/credentials/generate-ice-servers`,
24 h TTL), shares them with everyone and fetches new ones after 12 h. URLs on port 53 are left
out (browsers time out on them). If Cloudflare can't be reached it falls back to STUN and tries
again a minute later. Secrets are never logged; the API token is only sent to Cloudflare. Cloudflare's
TURN has a free monthly allowance; check its current terms before relying on it.

## Privacy
- Only players in your voice group can hear you: everyone in the room in the lobby, your own team
  in a match. The server enforces this for signaling, so a modified client can't connect to the
  other team during a match.
- Nobody else is involved: no media server, no recording. With a TURN relay the encrypted packets
  pass through Cloudflare (or our own TURN), which can't decrypt them.
- The mic is only opened after your tap to create or join a room (or a tap in it), and stopped when you leave or close the page.
- Players in your voice group can see your IP address: it is in the ICE candidates the browsers
  swap to find a direct path, even when the audio ends up going through a relay.

## Cautions and limits
- **HTTPS:** browsers only allow the mic on `https://` pages (and `http://localhost`). Phones on
  the same Wi-Fi testing `http://192.168.x.x:3000` get "Mic blocked"; they can still listen.
- **Headphones:** open mic plus speakers means echo for everyone else. Echo cancellation helps,
  but headphones are the real fix; the game says so once.
- Mesh size: fine for 8 players (at most 7 connections each, in the lobby). Many more would need a
  media server.
- No push-to-talk and no per-player volume yet.

## Troubleshooting
- **"Mic blocked":** allow the mic for the site (address bar, lock icon), then tap the chip. On
  `http://` pages other than localhost the mic is never available.
- **Can't hear anyone:** if the chip says "Tap to hear", tap anywhere (autoplay rules). Check the
  device volume and that the other player isn't muted.
- **"No voice":** this browser can't make WebRTC connections (an in-app browser, WebRTC turned
  off) or rejected the ICE config (check `TURN_URLS`). The game still works.
- **One player can't connect to anyone:** a strict network; configure TURN (above).
- **Dev stats:** in a dev build, `window.__voice` in the browser console shows your mic state, the
  relay setting, who is speaking, and per peer the connection state, bytes sent and received,
  round trip time, whether it goes through a relay, `maxBitrate` (our encoder cap toward them:
  28000 in the lobby, 16000 in a match), `sending` (our mic is on that connection), `level` (how loud they are reaching you, RMS;
  talking counts above 0.012) and `playing` (their audio element is playing). Refreshed every 2 s.
- **Testing with Chrome's fake mic:** `--use-fake-device-for-media-stream` gives every browser the
  same beep, and each page's echo canceller then removes much of its own mic (it matches what it
  is playing back), so speaking glows flicker or go missing. Give each test player its own
  browser and its own sound with `--use-file-for-fake-audio-capture=<file>.wav`.
- **Server side:** `npm run smoke -w server` checks the relay rules (lobby open, match
  team-only, forged `from` ignored, oversized messages dropped, floods cut).
- Colyseus closes a connection on any WebSocket message over 4 KB by default; the server raises
  this to 20 KB (`server/src/index.ts`) because an SDP can be bigger.
