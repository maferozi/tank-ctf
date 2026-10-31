import { Room, type Client } from "colyseus";
import { DEFAULT_MAP } from "@tank/shared";

// Phase 0 stub. Phase 2 runs the shared sim here and syncs it to clients.
export class GameRoom extends Room {
  maxClients = 8;

  onCreate() {
    console.log(`room ${this.roomId} created (map ${DEFAULT_MAP.cols}x${DEFAULT_MAP.rows})`);
  }

  onJoin(client: Client) {
    console.log(`${client.sessionId} joined ${this.roomId}`);
  }

  onLeave(client: Client) {
    console.log(`${client.sessionId} left ${this.roomId}`);
  }
}
