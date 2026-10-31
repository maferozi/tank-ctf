import { createEndpoint, createRouter, defineRoom, defineServer, listen, matchMaker } from "colyseus";
import { MAX_PLAYERS, normalizeRoomCode, type RoomInfo, type Roster } from "@tank/shared";
import { GameRoom } from "./GameRoom";

const PORT = Number(process.env.PORT ?? 2567);

// Who is in a room, read by the join form before joining.
const roomInfo = createEndpoint("/rooms/:code", { method: "GET" }, async (ctx) => {
  ctx.setHeader("Access-Control-Allow-Origin", "*");
  const code = normalizeRoomCode(ctx.params.code);
  const [room] = code ? await matchMaker.query({ roomId: code }) : [];
  if (!room) return ctx.json({ error: "no such room" }, { status: 404 });
  const metadata = room.metadata as Partial<Roster> | undefined;
  const info: RoomInfo = { code, players: metadata?.players ?? [], maxPlayers: room.maxClients ?? MAX_PLAYERS };
  return ctx.json(info);
});

const server = defineServer({
  rooms: {
    game: defineRoom(GameRoom),
  },
  routes: createRouter({ roomInfo }),
});

await listen(server, PORT);
