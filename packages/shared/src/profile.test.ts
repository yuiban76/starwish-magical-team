import { describe, expect, it } from "vitest";
import {
  CARD_BY_ID,
  CHARACTERS,
  CORE_DECK_CARD_IDS,
  GACHA_COST,
  GACHA_DUPLICATE_REFUND,
  PULLABLE_CARDS,
  PULLABLE_CHARACTERS,
  RARITY_ODDS,
  STARTER_CHARACTER_IDS,
} from "./content.js";
import {
  createPlayerProfile,
  drawFromPool,
  isValidDeckSelection,
  migratePlayerProfile,
} from "./profile.js";

describe("local collection and gacha", () => {
  it("starts with four usable heroines, the basic deck, and one free pull", () => {
    const profile = createPlayerProfile();
    expect(Object.keys(profile.ownedCharacterLevels)).toHaveLength(4);
    expect(STARTER_CHARACTER_IDS.every((id) => profile.ownedCharacterLevels[id] === 1)).toBe(true);
    expect(profile.ownedCardLevels).toEqual(Object.fromEntries(CORE_DECK_CARD_IDS.map((id) => [id, 1])));
    expect(profile.currency).toBe(GACHA_COST);
    expect(PULLABLE_CHARACTERS).toHaveLength(4);
    expect(PULLABLE_CARDS).toHaveLength(20);
    expect(PULLABLE_CARDS.filter((card) => card.rarity === "common")).toHaveLength(12);
    expect(PULLABLE_CARDS.filter((card) => card.rarity === "rare")).toHaveLength(6);
    expect(PULLABLE_CARDS.filter((card) => card.rarity === "epic")).toHaveLength(2);
  });

  it("uses separate pools and the published 60/30/10 rarity bands", () => {
    const profile = createPlayerProfile();
    const characterEpic = drawFromPool(profile, "character", () => 0.95);
    const cardEpic = drawFromPool(profile, "card", () => 0.95);
    expect(characterEpic.drop?.pool).toBe("character");
    expect(characterEpic.drop?.rarity).toBe("epic");
    expect(cardEpic.drop?.pool).toBe("card");
    expect(cardEpic.drop?.rarity).toBe("epic");

    let seed = 0x12345678;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    let current = { ...profile, currency: 1_000_000 };
    const counts = { common: 0, rare: 0, epic: 0 };
    const draws = 10_000;
    for (let index = 0; index < draws; index += 1) {
      const result = drawFromPool(current, "card", random);
      expect(result.drop).toBeDefined();
      counts[result.drop!.rarity] += 1;
      current = result.profile;
    }
    expect(Math.abs(counts.common / draws - RARITY_ODDS.common)).toBeLessThan(0.02);
    expect(Math.abs(counts.rare / draws - RARITY_ODDS.rare)).toBeLessThan(0.02);
    expect(Math.abs(counts.epic / draws - RARITY_ODDS.epic)).toBeLessThan(0.02);
  });

  it("raises duplicate levels to three, then refunds 25 without exceeding the cap", () => {
    const original = { ...createPlayerProfile(), currency: 1_000 };
    const fixedCommon = () => 0.1; // first common heroine: yume
    const first = drawFromPool(original, "character", fixedCommon);
    const second = drawFromPool(first.profile, "character", fixedCommon);
    const third = drawFromPool(second.profile, "character", fixedCommon);
    const capped = drawFromPool(third.profile, "character", fixedCommon);

    expect(first.drop).toMatchObject({ id: "yume", level: 1, upgraded: false, refunded: 0 });
    expect(second.drop).toMatchObject({ id: "yume", level: 2, upgraded: true, refunded: 0 });
    expect(third.drop).toMatchObject({ id: "yume", level: 3, upgraded: true, refunded: 0 });
    expect(capped.drop).toMatchObject({ id: "yume", level: 3, upgraded: false, refunded: GACHA_DUPLICATE_REFUND });
    expect(capped.profile.ownedCharacterLevels.yume).toBe(3);
    expect(capped.profile.currency).toBe(625);
    expect(original.currency).toBe(1_000);
    expect(original.ownedCharacterLevels.yume).toBeUndefined();
  });

  it("leaves an unaffordable collection unchanged and has no pity state", () => {
    const poorProfile = { ...createPlayerProfile(), currency: 99 };
    const result = drawFromPool(poorProfile, "card", () => 0.999);
    expect(result.error?.code).toBe("insufficient-currency");
    expect(result.profile.currency).toBe(99);
    expect(result.drop).toBeUndefined();
    expect(result.profile).not.toHaveProperty("pity");
  });

  it("migrates old or damaged local profile JSON while restoring starter content", () => {
    const migrated = migratePlayerProfile({
      version: 0,
      currency: -3,
      ownedCharacterLevels: { yume: 7, deleted_character: 2 },
      ownedCardLevels: { "spark-jab": 2, "deleted-card": 3 },
      selectedCharacterId: "deleted_character",
      selectedDeckCardIds: ["spark-jab"],
      completedRuns: 4,
      clearedEncounters: 9,
    });
    expect(migrated.version).toBe(1);
    expect(migrated.currency).toBe(0);
    expect(migrated.ownedCharacterLevels.yume).toBe(3);
    expect(migrated.ownedCharacterLevels.luna).toBe(1);
    expect(migrated.ownedCharacterLevels).not.toHaveProperty("deleted_character");
    expect(migrated.ownedCardLevels["spark-jab"]).toBe(2);
    expect(migrated.ownedCardLevels).not.toHaveProperty("deleted-card");
    expect(migrated.selectedCharacterId).toBe("luna");
    expect(migrated.selectedDeckCardIds).toEqual([]);
    expect(migrated.completedRuns).toBe(4);
    expect(migrated.clearedEncounters).toBe(9);
    expect(CHARACTERS).toHaveLength(8);
    expect(CARD_BY_ID.size).toBe(28);
  });

  it("limits permanent deck building to four owned replacements", () => {
    const profile = createPlayerProfile();
    profile.ownedCardLevels["spark-jab"] = 1;
    profile.ownedCardLevels.moonbeam = 1;
    profile.ownedCardLevels["petal-volley"] = 1;
    profile.ownedCardLevels["meteor-impact"] = 1;
    expect(isValidDeckSelection([
      "moonlight-strike", "comet-slash", "halo-guard", "prism-ward",
      "spark-jab", "moonbeam", "petal-volley", "meteor-impact",
    ], profile.ownedCardLevels)).toBe(true);
    expect(isValidDeckSelection([
      "spark-jab", "moonbeam", "petal-volley", "meteor-impact",
      "heart-mend", "eclipse-ray", "comet-storm", "astral-nova",
    ], profile.ownedCardLevels)).toBe(false);
  });
});
