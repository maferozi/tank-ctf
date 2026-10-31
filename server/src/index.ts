import { createEndpoint, createRouter, defineRoom, defineServer, listen, matchMaker } from "colyseus";
import { MAX_PLAYERS, isMatchRounds, normalizeRoomCode, roundMaps, type RoomInfo, type RoomMetadata } from "@tank/shared";
import { GameRoom } from "./GameRoom";

const PORT = Number(process.env.PORT ?? 2567);

// Who is in a room, read by the join form before joining.
const roomInfo = createEndpoint("/rooms/:code", { method: "GET" }, async (ctx) => {
  ctx.setHeader("Access-Control-Allow-Origin", "*");
  const code = normalizeRoomCode(ctx.params.code);
  const [room] = code ? await matchMaker.query({ roomId: code }) : [];
  if (!room) return ctx.json({ error: "no such room" }, { status: 404 });
  const metadata = room.metadata as Partial<RoomMetadata> | undefined;
  const info: RoomInfo = {
    code,
    players: metadata?.players ?? [],
    maxPlayers: room.maxClients ?? MAX_PLAYERS,
    rounds: isMatchRounds(metadata?.rounds) ? metadata.rounds : 1,
    maps: [],
    phase: metadata?.phase === "playing" ? "playing" : "lobby",
  };
  info.maps = roundMaps(info.rounds, metadata?.maps);
  return ctx.json(info);
});

// For the host's health check (Render pings this to know the server is up).
const health = createEndpoint("/health", { method: "GET" }, async (ctx) => ctx.json({ ok: true }));

const server = defineServer({
  rooms: {
    game: defineRoom(GameRoom),
  },
  routes: createRouter({ roomInfo, health }),
});

await listen(server, PORT);
