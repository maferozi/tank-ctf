import { defineRoom, defineServer, listen } from "colyseus";
import { GameRoom } from "./GameRoom";

const PORT = Number(process.env.PORT ?? 2567);

const server = defineServer({
  rooms: {
    game: defineRoom(GameRoom),
  },
});

await listen(server, PORT);
