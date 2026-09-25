import { describe, expect, it } from "vitest";
import { CORE_DECK_CARD_IDS } from "./content.js";
import { engine } from "./engine.js";
import { createPlayerProfile } from "./profile.js";
import type { StarwishGameState } from "./engine.js";

function joinRoom(playerIds: string[], attackHeavy = false): StarwishGameState {
  let state = engine.createRoom("STAR7");
  state.randomSeed = 0x13579bdf;
  for (const [playerIndex, playerId] of playerIds.entries()) {
    let profile = createPlayerProfile();
    profile.currency += playerIndex * 100;
    if (attackHeavy) {
      const extraIds = ["spark-jab", "moonbeam", "petal-volley", "meteor-impact"];
      for (const id of extraIds) profile.ownedCardLevels[id] = 1;
      profile.selectedDeckCardIds = [
        "moonlight-strike", "comet-slash", "tiny-spark", "halo-guard", ...extraIds,
      ];
    }
    const joined = engine.join(state, playerId, playerId, profile);
    expect(joined.error).toBeUndefined();
    state = joined.state;
  }
  return state;
}

function startRun(state: StarwishGameState, hostId: string): StarwishGameState {
  const started = engine.dispatch(state, hostId, { type: "start-run" });
  expect(started.error).toBeUndefined();
  expect(started.state.phase).toBe("combat");
  return started.state;
}

describe("shared game engine", () => {
  it("starts a one-player run and resolves simultaneous plans as one round", () => {
    let state = startRun(joinRoom(["solo"], true), "solo");
    expect(state.players.filter((player) => player.inRun)).toHaveLength(1);
    const view = engine.viewFor(state, "solo");
    expect(view.phase).toBe("combat");
    expect(view.encounterIndex).toBe(0);
    expect(view.self.hand).toHaveLength(5);
    expect(view.enemies).toHaveLength(1);

    const attack = view.self.hand.find((card) => card.kind === "attack");
    expect(attack).toBeDefined();
    const target = view.enemies[0]!.id;
    const planned = engine.dispatch(state, "solo", { type: "submit-plan", cardIds: [attack!.id], targets: [target] });
    expect(planned.error).toBeUndefined();
    state = planned.state;
    const ready = engine.dispatch(state, "solo", { type: "ready" });
    expect(ready.error).toBeUndefined();
    state = ready.state;
    expect(state.round).toBe(2);
    expect(state.enemies[0]!.hp).toBeLessThan(state.enemies[0]!.maxHp);
    expect(engine.viewFor(state, "solo").self.discardCount).toBe(1);
  });

  it("does not resolve until every connected living participant is ready", () => {
    let state = startRun(joinRoom(["alice", "bob"]), "alice");
    for (const playerId of ["alice", "bob"]) {
      const planned = engine.dispatch(state, playerId, { type: "submit-plan", cardIds: [], targets: [] });
      expect(planned.error).toBeUndefined();
      state = planned.state;
    }
    const firstReady = engine.dispatch(state, "alice", { type: "ready" });
    state = firstReady.state;
    expect(state.round).toBe(1);
    expect(state.players.find((player) => player.id === "bob")?.isReady).toBe(false);
    const secondReady = engine.dispatch(state, "bob", { type: "ready" });
    state = secondReady.state;
    expect(state.round).toBe(2);
  });

  it("keeps private hands and collection data out of other players' views", () => {
    const state = startRun(joinRoom(["alice", "bob"]), "alice");
    const aliceView = engine.viewFor(state, "alice");
    const bobView = engine.viewFor(state, "bob");
    expect(aliceView.self.hand).toHaveLength(5);
    expect(bobView.players.find((player) => player.id === "alice")?.handCount).toBe(5);
    expect(bobView.players.find((player) => player.id === "alice")).not.toHaveProperty("hand");
    expect(bobView.players.find((player) => player.id === "alice")).not.toHaveProperty("collection");
    expect(aliceView.self.collection.currency).toBe(100);
    expect(bobView.self.collection.currency).toBe(200);
  });

  it("lets the team continue when a seat disconnects and preserves that seat for rejoin", () => {
    let state = startRun(joinRoom(["alice", "bob"]), "alice");
    const planned = engine.dispatch(state, "alice", { type: "submit-plan", cardIds: [], targets: [] });
    state = planned.state;
    state = engine.dispatch(state, "alice", { type: "ready" }).state;
    expect(state.round).toBe(1);

    const disconnected = engine.disconnect(state, "bob");
    state = disconnected.state;
    expect(state.players).toHaveLength(2);
    expect(state.players.find((player) => player.id === "bob")?.connected).toBe(false);
    expect(state.round).toBe(2);

    const restored = engine.join(state, "bob", "bob", createPlayerProfile());
    expect(restored.error).toBeUndefined();
    expect(restored.state.players).toHaveLength(2);
    expect(restored.state.players.find((player) => player.id === "bob")?.connected).toBe(true);
  });

  it("rejects forged card plays and resolves a cleared encounter into a shared reward", () => {
    let state = startRun(joinRoom(["solo"], true), "solo");
    const hand = engine.viewFor(state, "solo").self.hand;
    const attack = hand.find((card) => card.kind === "attack")!;
    const forged = engine.dispatch(state, "solo", {
      type: "submit-plan",
      cardIds: ["astral-nova"],
      targets: [state.enemies[0]!.id],
    });
    expect(forged.error?.code).toBe("card-not-in-hand");

    state.enemies[0]!.hp = 1;
    const planned = engine.dispatch(state, "solo", { type: "submit-plan", cardIds: [attack.id], targets: [state.enemies[0]!.id] });
    state = planned.state;
    state = engine.dispatch(state, "solo", { type: "ready" }).state;
    expect(state.phase).toBe("reward");
    expect(state.rewardOptions).toHaveLength(3);
    expect(state.players[0]!.profile.currency).toBe(130);
    expect(state.players[0]!.profile.clearedEncounters).toBe(1);

    const option = state.rewardOptions[0]!;
    state = engine.dispatch(state, "solo", { type: "choose-reward", cardId: option }).state;
    expect(state.phase).toBe("combat");
    expect(state.encounterIndex).toBe(1);
    expect(state.players[0]!.runDeck).toContain(option);
  });

  it("completes three regular rewards and the boss reward in a solo run", () => {
    let state = startRun(joinRoom(["solo"]), "solo");
    for (let encounter = 0; encounter < 3; encounter += 1) {
      expect(state.encounterIndex).toBe(encounter);
      state.enemies[0]!.hp = 0;
      state = engine.dispatch(state, "solo", { type: "submit-plan", cardIds: [], targets: [] }).state;
      state = engine.dispatch(state, "solo", { type: "ready" }).state;
      expect(state.phase).toBe("reward");
      expect(state.players[0]!.profile.currency).toBe(130 + encounter * 30);
      const chosenCard = state.rewardOptions[0]!;
      state = engine.dispatch(state, "solo", { type: "choose-reward", cardId: chosenCard }).state;
    }

    expect(state.encounterIndex).toBe(3);
    expect(state.phase).toBe("combat");
    state.enemies[0]!.hp = 0;
    state = engine.dispatch(state, "solo", { type: "submit-plan", cardIds: [], targets: [] }).state;
    state = engine.dispatch(state, "solo", { type: "ready" }).state;
    expect(state.phase).toBe("victory");
    expect(state.players[0]!.profile.currency).toBe(250);
    expect(state.players[0]!.profile.clearedEncounters).toBe(4);
    expect(state.players[0]!.profile.completedRuns).toBe(1);
  });

  it("rejects invalid targets and decks, and keeps four base cards in a valid replacement deck", () => {
    let state = joinRoom(["solo"]);
    const badDeck = engine.dispatch(state, "solo", { type: "set-deck", cardIds: CORE_DECK_CARD_IDS.slice(0, 7) as string[] });
    expect(badDeck.error?.code).toBe("invalid-deck");
    state = startRun(state, "solo");
    const attack = engine.viewFor(state, "solo").self.hand.find((card) => card.kind === "attack")!;
    const invalidTarget = engine.dispatch(state, "solo", { type: "submit-plan", cardIds: [attack.id], targets: ["missing-enemy"] });
    expect(invalidTarget.error?.code).toBe("invalid-target");
  });
});
