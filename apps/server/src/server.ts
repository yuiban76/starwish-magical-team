import { randomBytes, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath, URL } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type {
  GameAction,
  GameEngine,
  GameView,
  PlayerProfile,
  RoomCreationResponse,
  ServerMessage,
} from "@starwish/shared";

const SAVE_VERSION = 1;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PLAYERS = 4;
const MAX_DISPLAY_NAME_LENGTH = 24;
const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/;

interface PlayerSeat {
  playerId: string;
  displayName: string;
  profile: PlayerProfile;
  resumeToken: string;
}

interface Room<State> {
  roomCode: string;
  state: State;
  seats: Map<string, PlayerSeat>;
  sockets: Map<string, WebSocket>;
}

interface PersistedRoom<State> {
  version: 1;
  savedAt: string;
  roomCode: string;
  state: State;
  seats: PlayerSeat[];
}

export interface GameServerOptions<State> {
  engine: GameEngine<State>;
  host?: string;
  port?: number;
  dataDirectory?: string;
  webDirectory?: string;
  logger?: Pick<Console, "error" | "warn">;
}

export interface RunningGameServer {
  server: Server;
  address: { host: string; port: number };
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const webSocketServers = new WeakMap<Server, WebSocketServer>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerBetween(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80;
}

function isStringArray(value: unknown, maxItems: number): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every(isId);
}

function isLevelMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.keys(value).length <= 500 &&
    Object.entries(value).every(([key, level]) => key.length <= 80 && isIntegerBetween(level, 1, 3))
  );
}

function isPlayerProfile(value: unknown): value is PlayerProfile {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    isIntegerBetween(value.currency, 0, 2_000_000_000) &&
    isLevelMap(value.ownedCharacterLevels) &&
    isLevelMap(value.ownedCardLevels) &&
    (value.selectedCharacterId === "" || isId(value.selectedCharacterId)) &&
    isStringArray(value.selectedDeckCardIds, 80) &&
    isIntegerBetween(value.completedRuns, 0, 2_000_000_000) &&
    isIntegerBetween(value.clearedEncounters, 0, 2_000_000_000)
  );
}

function normalizeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, MAX_DISPLAY_NAME_LENGTH);
  return name.length > 0 ? name : undefined;
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { type: "error", code, message });
}

function rawDataBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function sendHttpJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function randomRoomCode(existing: { has(key: string): boolean }): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const bytes = randomBytes(6);
    let code = "";
    for (const byte of bytes) code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
    if (!existing.has(code)) return code;
  }
  throw new Error("Could not allocate a unique room code");
}

function isPrivateIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31
  );
}

function joinAddresses(roomCode: string, port: number): RoomCreationResponse["addresses"] {
  const addresses: RoomCreationResponse["addresses"] = [];
  const seen = new Set<string>();
  for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || seen.has(entry.address)) continue;
      const hamachi = /hamachi/i.test(interfaceName) || entry.address.startsWith("25.");
      if (!hamachi && !isPrivateIPv4(entry.address)) continue;
      seen.add(entry.address);
      const kind = hamachi ? "hamachi" : "local";
      addresses.push({
        kind,
        ip: entry.address,
        url: `http://${entry.address}:${port}/?room=${roomCode}`,
      });
    }
  }
  if (addresses.length === 0) {
    addresses.push({
      kind: "local",
      ip: "127.0.0.1",
      url: `http://127.0.0.1:${port}/?room=${roomCode}`,
    });
  }
  return addresses;
}

function isAction(value: unknown): value is GameAction {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "select-character":
      return isId(value.characterId);
    case "set-deck":
      return isStringArray(value.cardIds, 80);
    case "start-run":
    case "ready":
      return true;
    case "submit-plan":
      return isStringArray(value.cardIds, 20) && isStringArray(value.targets, 20);
    case "choose-reward":
      return isId(value.cardId);
    default:
      return false;
  }
}

function parseJoin(value: unknown): { displayName: string; profile: PlayerProfile; resumeToken?: string } | undefined {
  if (!isRecord(value) || value.type !== "join") return undefined;
  const displayName = normalizeDisplayName(value.displayName);
  if (!displayName || !isPlayerProfile(value.profile)) return undefined;
  if (value.resumeToken !== undefined && (typeof value.resumeToken !== "string" || !/^[a-f0-9]{48}$/.test(value.resumeToken))) {
    return undefined;
  }
  return {
    displayName,
    profile: value.profile,
    ...(typeof value.resumeToken === "string" ? { resumeToken: value.resumeToken } : {}),
  };
}

function isValidPersistedSeat(value: unknown): value is PlayerSeat {
  return (
    isRecord(value) &&
    isId(value.playerId) &&
    typeof value.displayName === "string" &&
    value.displayName.length > 0 &&
    value.displayName.length <= MAX_DISPLAY_NAME_LENGTH &&
    isPlayerProfile(value.profile) &&
    typeof value.resumeToken === "string" &&
    /^[a-f0-9]{48}$/.test(value.resumeToken)
  );
}

function getStateRoomView<State>(engine: GameEngine<State>, room: Room<State>, playerId: string): GameView {
  return engine.viewFor(room.state, playerId);
}

function safeBroadcast<State>(
  engine: GameEngine<State>,
  room: Room<State>,
  logger: Pick<Console, "error" | "warn">,
): void {
  for (const [playerId, ws] of room.sockets) {
    try {
      send(ws, { type: "state", view: getStateRoomView(engine, room, playerId) });
    } catch (error) {
      logger.error(`Failed to create private view for player ${playerId} in room ${room.roomCode}`, error);
      sendError(ws, "STATE_ERROR", "無法載入房間狀態，請重新連線。");
    }
  }
}

function writeRoomSave<State>(room: Room<State>, dataDirectory: string): void {
  mkdirSync(dataDirectory, { recursive: true });
  const data: PersistedRoom<State> = {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    roomCode: room.roomCode,
    state: room.state,
    seats: [...room.seats.values()],
  };
  const destination = join(dataDirectory, `${room.roomCode}.json`);
  const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(data), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The original rename error carries the useful failure information.
    }
    throw error;
  }
}

function restoreRooms<State>(
  engine: GameEngine<State>,
  rooms: Map<string, Room<State>>,
  dataDirectory: string,
  logger: Pick<Console, "error" | "warn">,
): void {
  if (!existsSync(dataDirectory)) return;
  let names: string[];
  try {
    names = readdirSync(dataDirectory);
  } catch (error) {
    logger.error(`Could not read room save directory ${dataDirectory}`, error);
    return;
  }
  for (const name of names) {
    if (!/^[A-Z2-9]{6}\.json$/.test(name)) continue;
    const filename = join(dataDirectory, name);
    try {
      const save: unknown = JSON.parse(readFileSync(filename, "utf8"));
      if (!isRecord(save) || save.version !== SAVE_VERSION || save.roomCode !== name.slice(0, 6)) {
        logger.warn(`Ignoring incompatible room save ${filename}`);
        continue;
      }
      if (!Array.isArray(save.seats) || save.seats.length > MAX_PLAYERS || !save.seats.every(isValidPersistedSeat)) {
        logger.warn(`Ignoring invalid room seats in ${filename}`);
        continue;
      }
      if (new Set(save.seats.map((seat) => seat.playerId)).size !== save.seats.length ||
          new Set(save.seats.map((seat) => seat.resumeToken)).size !== save.seats.length) {
        logger.warn(`Ignoring duplicate room seats in ${filename}`);
        continue;
      }
      const room: Room<State> = {
        roomCode: save.roomCode,
        state: save.state as State,
        seats: new Map((save.seats as PlayerSeat[]).map((seat) => [seat.resumeToken, seat])),
        sockets: new Map(),
      };
      for (const seat of room.seats.values()) {
        const disconnected = engine.disconnect(room.state, seat.playerId);
        if (!disconnected.error) room.state = disconnected.state;
        engine.viewFor(room.state, seat.playerId);
      }
      if (room.seats.size > 0) writeRoomSave(room, dataDirectory);
      rooms.set(room.roomCode, room);
    } catch (error) {
      logger.warn(`Ignoring unreadable room save ${filename}: ${String(error)}`);
    }
  }
}

function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  webDirectory: string,
): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendHttpJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "只支援 GET 或 HEAD。" });
    return;
  }
  const decodedPath = decodeURIComponent(url.pathname);
  const requestedPath = decodedPath === "/" ? "/index.html" : decodedPath;
  const root = resolve(webDirectory);
  const target = resolve(root, `.${requestedPath}`);
  const relativePath = relative(root, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    sendHttpJson(response, 400, { error: "BAD_PATH", message: "無效的路徑。" });
    return;
  }
  let filename = target;
  if (!existsSync(filename)) filename = join(webDirectory, "index.html");
  if (!existsSync(filename)) {
    sendHttpJson(response, 503, { error: "WEB_BUILD_MISSING", message: "找不到網頁檔案，請先執行 pnpm --filter @starwish/web build。" });
    return;
  }
  response.writeHead(200, {
    "content-type": MIME_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream",
    "cache-control": filename.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
  });
  if (request.method === "HEAD") response.end();
  else {
    const stream = createReadStream(filename);
    stream.on("error", () => {
      if (!response.headersSent) sendHttpJson(response, 404, { error: "NOT_FOUND", message: "找不到這個檔案。" });
      else response.destroy();
    });
    stream.pipe(response);
  }
}

export function createGameServer<State>(options: GameServerOptions<State>): Server {
  const { engine } = options;
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 3000;
  const dataDirectory = resolve(options.dataDirectory ?? fileURLToPath(new URL("../data/", import.meta.url)));
  const webDirectory = resolve(options.webDirectory ?? fileURLToPath(new URL("../../web/dist/", import.meta.url)));
  const logger = options.logger ?? console;
  const rooms = new Map<string, Room<State>>();

  restoreRooms(engine, rooms, dataDirectory, logger);

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname === "/api/health" && request.method === "GET") {
        sendHttpJson(response, 200, {
          ok: true,
          rooms: rooms.size,
          connectedPlayers: [...rooms.values()].reduce((total, room) => total + room.sockets.size, 0),
        });
        return;
      }
      if (url.pathname === "/api/rooms" && request.method === "POST") {
        request.resume();
        const roomCode = randomRoomCode(rooms);
        let state: State;
        try {
          state = engine.createRoom(roomCode);
        } catch (error) {
          logger.error("Failed to create game room", error);
          sendHttpJson(response, 500, { error: "ROOM_CREATE_FAILED", message: "建立房間失敗，請稍後再試。" });
          return;
        }
        const room: Room<State> = { roomCode, state, seats: new Map(), sockets: new Map() };
        rooms.set(roomCode, room);
        try {
          writeRoomSave(room, dataDirectory);
        } catch (error) {
          rooms.delete(roomCode);
          logger.error(`Failed to save new room ${roomCode}`, error);
          sendHttpJson(response, 500, { error: "ROOM_SAVE_FAILED", message: "無法保存房間，請確認主機資料夾可寫入。" });
          return;
        }
        const address = server.address();
        const boundPort = typeof address === "object" && address ? address.port : port;
        sendHttpJson(response, 201, {
          roomCode,
          addresses: joinAddresses(roomCode, boundPort),
        } satisfies RoomCreationResponse);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        sendHttpJson(response, 404, { error: "NOT_FOUND", message: "找不到這個 API。" });
        return;
      }
      serveStatic(request, response, url, webDirectory);
    } catch (error) {
      if (error instanceof URIError) {
        sendHttpJson(response, 400, { error: "BAD_PATH", message: "無效的路徑。" });
        return;
      }
      logger.error("HTTP request failed", error);
      if (!response.headersSent) sendHttpJson(response, 500, { error: "INTERNAL_ERROR", message: "伺服器發生錯誤。" });
      else response.destroy();
    }
  });

  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  server.on("upgrade", (request, socket, head) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (url.pathname !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (ws) => {
      webSockets.emit("connection", ws, request);
    });
  });

  webSocketServers.set(server, webSockets);
  webSockets.on("connection", (ws: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? "/ws", `http://${request.headers.host ?? "localhost"}`);
    const roomCode = (url.searchParams.get("room") ?? "").trim().toUpperCase();
    const room = ROOM_CODE_PATTERN.test(roomCode) ? rooms.get(roomCode) : undefined;
    if (!room) {
      sendError(ws, "ROOM_NOT_FOUND", "找不到這個房間，請確認房間代碼。");
      ws.close(4404, "Room not found");
      return;
    }

    let joinedPlayerId: string | undefined;
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        sendError(ws, "INVALID_MESSAGE", "房間只接受文字訊息。");
        return;
      }
      const payload = rawDataBuffer(data);
      if (payload.byteLength > MAX_MESSAGE_BYTES) {
        sendError(ws, "MESSAGE_TOO_LARGE", "訊息太大。");
        ws.close(4400, "Message too large");
        return;
      }
      let command: unknown;
      try {
        command = JSON.parse(payload.toString("utf8"));
      } catch {
        sendError(ws, "INVALID_JSON", "訊息格式錯誤，請重新操作。");
        return;
      }

      if (!joinedPlayerId) {
        const join = parseJoin(command);
        if (!join) {
          sendError(ws, "JOIN_REQUIRED", "請提供有效的暱稱與玩家資料後加入房間。");
          ws.close(4400, "Join required");
          return;
        }
        const existingSeat = join.resumeToken ? room.seats.get(join.resumeToken) : undefined;
        if (join.resumeToken && !existingSeat) {
          sendError(ws, "RESUME_INVALID", "重連資料已失效，請重新加入房間。");
          ws.close(4401, "Resume token invalid");
          return;
        }
        if (!existingSeat && room.seats.size >= MAX_PLAYERS) {
          sendError(ws, "ROOM_FULL", "房間已滿，最多可有 4 位玩家。");
          ws.close(4409, "Room full");
          return;
        }
        const seat: PlayerSeat = existingSeat ?? {
          playerId: randomUUID(),
          displayName: join.displayName,
          profile: join.profile,
          resumeToken: randomBytes(24).toString("hex"),
        };
        let result;
        try {
          result = engine.join(room.state, seat.playerId, seat.displayName, seat.profile);
        } catch (error) {
          logger.error(`Engine join failed in room ${roomCode}`, error);
          sendError(ws, "JOIN_FAILED", "加入房間失敗，請重新連線。");
          return;
        }
        if (result.error) {
          sendError(ws, result.error.code, result.error.message);
          return;
        }
        const previousState = room.state;
        room.state = result.state;
        room.seats.set(seat.resumeToken, seat);
        try {
          writeRoomSave(room, dataDirectory);
        } catch (error) {
          room.state = previousState;
          if (!existingSeat) room.seats.delete(seat.resumeToken);
          logger.error(`Failed to persist player join in room ${roomCode}`, error);
          sendError(ws, "SAVE_FAILED", "房間存檔失敗，請通知房主檢查資料夾權限。");
          return;
        }
        joinedPlayerId = seat.playerId;
        const oldSocket = room.sockets.get(seat.playerId);
        if (oldSocket && oldSocket !== ws) oldSocket.close(4001, "Session resumed elsewhere");
        room.sockets.set(seat.playerId, ws);
        send(ws, {
          type: "connected",
          playerId: seat.playerId,
          resumeToken: seat.resumeToken,
          roomCode,
          protocolVersion: 1,
        });
        for (const notice of result.notices ?? []) {
          for (const client of room.sockets.values()) send(client, { type: "notice", message: notice });
        }
        safeBroadcast(engine, room, logger);
        return;
      }

      if (isRecord(command) && command.type === "join") {
        sendError(ws, "ALREADY_JOINED", "你已經在房間裡了。");
        return;
      }
      if (!isAction(command)) {
        sendError(ws, "INVALID_ACTION", "這項操作格式無效。");
        return;
      }
      let result;
      try {
        result = engine.dispatch(room.state, joinedPlayerId, command);
      } catch (error) {
        logger.error(`Engine dispatch failed in room ${roomCode}`, error);
        sendError(ws, "ACTION_FAILED", "操作失敗，請稍後再試。");
        return;
      }
      if (result.error) {
        sendError(ws, result.error.code, result.error.message);
        return;
      }
      const previousState = room.state;
      room.state = result.state;
      try {
        writeRoomSave(room, dataDirectory);
      } catch (error) {
        room.state = previousState;
        logger.error(`Failed to persist action in room ${roomCode}`, error);
        sendError(ws, "SAVE_FAILED", "房間存檔失敗，請通知房主檢查資料夾權限。");
        safeBroadcast(engine, room, logger);
        return;
      }
      for (const notice of result.notices ?? []) {
        for (const client of room.sockets.values()) send(client, { type: "notice", message: notice });
      }
      safeBroadcast(engine, room, logger);
    });

    ws.on("close", () => {
      if (!joinedPlayerId || room.sockets.get(joinedPlayerId) !== ws) return;
      room.sockets.delete(joinedPlayerId);
      const result = engine.disconnect(room.state, joinedPlayerId);
      if (!result.error) room.state = result.state;
      for (const notice of result.notices ?? []) {
        for (const client of room.sockets.values()) send(client, { type: "notice", message: notice });
      }
      try {
        writeRoomSave(room, dataDirectory);
      } catch (error) {
        logger.error(`Failed to persist disconnect in room ${roomCode}`, error);
      }
      safeBroadcast(engine, room, logger);
    });
    ws.on("error", (error) => logger.warn(`WebSocket error in room ${roomCode}: ${String(error)}`));
  });

  return server;
}

export async function startGameServer<State>(options: GameServerOptions<State>): Promise<RunningGameServer> {
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 3000;
  const server = createGameServer(options);
  await new Promise<void>((resolveStart, rejectStart) => {
    const onError = (error: Error) => rejectStart(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveStart();
    });
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Server did not bind to a TCP address");
  return {
    server,
    address: { host, port: bound.port },
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      const webSockets = webSocketServers.get(server);
      const clients = [...(webSockets?.clients ?? [])];
      let terminateTimer: NodeJS.Timeout | undefined;
      let didStartClosing = false;
      const finish = () => {
        if (didStartClosing) return;
        didStartClosing = true;
        if (terminateTimer) clearTimeout(terminateTimer);
        server.close((error) => {
          webSockets?.close((socketError) => {
            const finalError = error ?? socketError;
            if (finalError) rejectClose(finalError);
            else resolveClose();
          });
        });
      };
      if (clients.length === 0) {
        finish();
        return;
      }
      let pending = clients.length;
      const onClientClosed = () => {
        pending -= 1;
        if (pending === 0) finish();
      };
      for (const client of clients) {
        client.once("close", onClientClosed);
        client.close(1001, "Server shutting down");
      }
      terminateTimer = setTimeout(() => {
        for (const client of clients) client.terminate();
      }, 1_000);
      terminateTimer.unref();
    }),
  };
}
