import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { GameEngine, GameView, PlayerProfile } from "@starwish/shared";
import { startGameServer, type RunningGameServer } from "./server.js";

interface TestState {
  roomCode: string;
  joined: Array<{ id: string; name: string; profile: PlayerProfile; connected: boolean }>;
  ready: string[];
}

const profile: PlayerProfile = {
  version: 1,
  currency: 100,
  ownedCharacterLevels: { star: 1 },
  ownedCardLevels: { spark: 1 },
  selectedCharacterId: "star",
  selectedDeckCardIds: ["spark"],
  completedRuns: 0,
  clearedEncounters: 0,
};

function testEngine(): GameEngine<TestState> {
  return {
    createRoom: (roomCode) => ({ roomCode, joined: [], ready: [] }),
    join: (state, id, name, playerProfile) => {
      const joined = state.joined.some((player) => player.id === id)
        ? state.joined.map((player) => player.id === id ? { ...player, connected: true } : player)
        : [...state.joined, { id, name, profile: playerProfile, connected: true }];
      return { state: { ...state, joined } };
    },
    disconnect: (state, playerId) => ({
      state: { ...state, joined: state.joined.map((player) => player.id === playerId ? { ...player, connected: false } : player) },
    }),
    dispatch: (state, playerId, action) => {
      if (action.type !== "ready") return { state, error: { code: "TEST_ACTION", message: "Unsupported" } };
      return { state: { ...state, ready: [...state.ready, playerId] } };
    },
    viewFor: (state, playerId): GameView => {
      const player = state.joined.find((candidate) => candidate.id === playerId);
      if (!player) throw new Error("Unknown test player");
      return {
        protocolVersion: 1,
        roomCode: state.roomCode,
        phase: "lobby",
        encounterIndex: 0,
        round: 0,
        players: state.joined.map((candidate) => ({
          id: candidate.id,
          displayName: candidate.name,
          connected: candidate.connected,
          isReady: state.ready.includes(candidate.id),
          characterId: "star",
          hp: 40,
          maxHp: 40,
          block: 0,
          energy: 0,
          maxEnergy: 3,
          handCount: 1,
        })),
        self: {
          hand: [{ id: `private-${player.id}`, name: "Private", description: "Only the player sees this", cost: 0, rarity: "common", kind: "attack", value: 1, level: 1, color: "#000" }],
          deckCount: 0,
          discardCount: 0,
          selectedCardIds: [],
          selectedTargets: [],
          currency: player.profile.currency,
          collection: player.profile,
          ownedCharacterLevels: player.profile.ownedCharacterLevels,
          ownedCardLevels: player.profile.ownedCardLevels,
        },
        enemies: [],
        rewardOptions: [],
        battleLog: [],
        hostPlayerId: state.joined[0]?.id ?? playerId,
      };
    },
  };
}

const servers: RunningGameServer[] = [];
const sockets: WebSocket[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
  for (const running of servers.splice(0)) await running.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function serverWithTemporaryData(engine = testEngine()) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "starwish-server-test-"));
  directories.push(dataDirectory);
  return serverInDirectory(dataDirectory, engine);
}

async function serverInDirectory(dataDirectory: string, engine = testEngine()) {
  const running = await startGameServer({ engine, host: "127.0.0.1", port: 0, dataDirectory, webDirectory: join(dataDirectory, "missing-web") });
  servers.push(running);
  return running;
}

async function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  const [data] = await once(socket, "message");
  return JSON.parse(data.toString()) as Record<string, unknown>;
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await once(socket, "open");
  return socket;
}

describe("local host server", () => {
  it("creates rooms, exposes health, and serves a private view to each player", async () => {
    const running = await serverWithTemporaryData();
    const base = `http://127.0.0.1:${running.address.port}`;
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, rooms: 0, connectedPlayers: 0 });

    const created = await fetch(`${base}/api/rooms`, { method: "POST" });
    expect(created.status).toBe(201);
    const room = await created.json() as { roomCode: string; addresses: Array<{ url: string }> };
    expect(room.roomCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(room.addresses.length).toBeGreaterThan(0);

    const url = `ws://127.0.0.1:${running.address.port}/ws?room=${room.roomCode}`;
    const first = await connect(url);
    first.send(JSON.stringify({ type: "join", displayName: "星星", profile }));
    const firstConnected = await nextMessage(first);
    const firstState = await nextMessage(first);
    expect(firstConnected).toMatchObject({ type: "connected", roomCode: room.roomCode, protocolVersion: 1 });
    expect(firstState).toMatchObject({ type: "state", view: { self: { hand: [{ id: expect.stringContaining("private-") }] } } });
    const firstId = firstConnected.playerId as string;

    const second = await connect(url);
    second.send(JSON.stringify({ type: "join", displayName: "月月", profile }));
    const secondConnected = await nextMessage(second);
    const secondState = await nextMessage(second);
    expect(secondConnected.type).toBe("connected");
    const secondHand = ((secondState.view as GameView).self.hand[0]?.id);
    expect(secondHand).not.toBe(`private-${firstId}`);

    const firstUpdate = await nextMessage(first);
    const secondUpdate = await nextMessage(second);
    expect(JSON.stringify(firstUpdate)).not.toContain(`private-${secondConnected.playerId}`);
    expect(JSON.stringify(secondUpdate)).not.toContain(`private-${firstId}`);

    first.send(JSON.stringify({ type: "ready" }));
    const firstReadyUpdate = await nextMessage(first);
    const secondReadyUpdate = await nextMessage(second);
    expect((firstReadyUpdate.view as GameView).players.find((player) => player.id === firstId)?.isReady).toBe(true);
    expect((secondReadyUpdate.view as GameView).players.find((player) => player.id === firstId)?.isReady).toBe(true);
  });

  it("rejects invalid room codes and persists versioned host saves", async () => {
    const running = await serverWithTemporaryData();
    const base = `http://127.0.0.1:${running.address.port}`;
    const invalid = new WebSocket(`ws://127.0.0.1:${running.address.port}/ws?room=ABCDEF`);
    sockets.push(invalid);
    await once(invalid, "open");
    expect(await nextMessage(invalid)).toMatchObject({ type: "error", code: "ROOM_NOT_FOUND" });

    const response = await fetch(`${base}/api/rooms`, { method: "POST" });
    const room = await response.json() as { roomCode: string };
    const filename = join(directories.at(-1)!, `${room.roomCode}.json`);
    const saved = JSON.parse(readFileSync(filename, "utf8")) as { version: number; roomCode: string; state: TestState };
    expect(saved).toMatchObject({ version: 1, roomCode: room.roomCode, state: { roomCode: room.roomCode } });
  });

  it("resumes an existing seat with the same player id and token after reconnect", async () => {
    const running = await serverWithTemporaryData();
    const base = `http://127.0.0.1:${running.address.port}`;
    const created = await (await fetch(`${base}/api/rooms`, { method: "POST" })).json() as { roomCode: string };
    const url = `ws://127.0.0.1:${running.address.port}/ws?room=${created.roomCode}`;
    const first = await connect(url);
    first.send(JSON.stringify({ type: "join", displayName: "重連玩家", profile }));
    const connected = await nextMessage(first);
    await nextMessage(first);
    const closeEvent = once(first, "close");
    first.close();
    await closeEvent;

    const resumed = await connect(url);
    resumed.send(JSON.stringify({ type: "join", displayName: "其他名字", profile, resumeToken: connected.resumeToken }));
    const resumedConnected = await nextMessage(resumed);
    expect(resumedConnected).toMatchObject({ playerId: connected.playerId, resumeToken: connected.resumeToken });
    await nextMessage(resumed);
  });

  it("restores a saved room and player state after the host process restarts", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "starwish-server-restart-test-"));
    directories.push(dataDirectory);
    const engine = testEngine();
    const firstHost = await serverInDirectory(dataDirectory, engine);
    const firstBase = `http://127.0.0.1:${firstHost.address.port}`;
    const created = await (await fetch(`${firstBase}/api/rooms`, { method: "POST" })).json() as { roomCode: string };
    const url = `ws://127.0.0.1:${firstHost.address.port}/ws?room=${created.roomCode}`;
    const player = await connect(url);
    player.send(JSON.stringify({ type: "join", displayName: "持續冒險", profile }));
    const connected = await nextMessage(player);
    await nextMessage(player);
    player.send(JSON.stringify({ type: "ready" }));
    const updated = await nextMessage(player);
    expect((updated.view as GameView).players[0]?.isReady).toBe(true);

    await firstHost.close();
    servers.splice(servers.indexOf(firstHost), 1);

    const secondHost = await serverInDirectory(dataDirectory, engine);
    const secondBase = `http://127.0.0.1:${secondHost.address.port}`;
    expect(await (await fetch(`${secondBase}/api/health`)).json()).toMatchObject({ ok: true, rooms: 1, connectedPlayers: 0 });
    const resumed = await connect(`ws://127.0.0.1:${secondHost.address.port}/ws?room=${created.roomCode}`);
    resumed.send(JSON.stringify({ type: "join", displayName: "恢復玩家", profile, resumeToken: connected.resumeToken }));
    const resumedConnected = await nextMessage(resumed);
    const restored = await nextMessage(resumed) as { type: string; view: GameView };
    expect(resumedConnected).toMatchObject({ playerId: connected.playerId, resumeToken: connected.resumeToken });
    expect(restored.view.roomCode).toBe(created.roomCode);
    expect(restored.view.players[0]?.isReady).toBe(true);
    expect(restored.view.self.currency).toBe(profile.currency);
  });
});
