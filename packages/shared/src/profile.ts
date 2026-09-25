import {
  CARD_BY_ID,
  CHARACTERS,
  CHARACTER_BY_ID,
  CORE_DECK_CARD_IDS,
  GACHA_COST,
  GACHA_DUPLICATE_REFUND,
  MAX_COLLECTION_LEVEL,
  PULLABLE_CARDS,
  PULLABLE_CHARACTERS,
  RARITY_ODDS,
  STARTER_CARD_SET,
  STARTER_CHARACTER_IDS,
  STARTING_CURRENCY,
  scaledStat,
} from "./content.js";
import type { PlayerProfile, PoolKind } from "./protocol.js";

export interface GachaDrop {
  pool: PoolKind;
  id: string;
  name: string;
  rarity: "common" | "rare" | "epic";
  level: number;
  upgraded: boolean;
  refunded: number;
}

export interface GachaResult {
  profile: PlayerProfile;
  drop?: GachaDrop;
  error?: { code: "insufficient-currency"; message: string };
}

export const DECK_SIZE = CORE_DECK_CARD_IDS.length;
export const MAX_REPLACEMENT_CARDS = 4;
export const INITIAL_HAND_SIZE = 5;
export const MAX_HAND_SIZE = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function sanitizeLevels(value: unknown, allowedIds: ReadonlySet<string>): Record<string, number> {
  const result: Record<string, number> = {};
  if (!isRecord(value)) return result;
  for (const [id, rawLevel] of Object.entries(value)) {
    if (!allowedIds.has(id)) continue;
    const level = safeInteger(rawLevel);
    if (level >= 1) result[id] = Math.min(MAX_COLLECTION_LEVEL, level);
  }
  return result;
}

const ALL_CHARACTER_IDS = new Set(CHARACTERS.map((character) => character.id));
const ALL_CARD_IDS = new Set(CARD_BY_ID.keys());

function starterProfile(): PlayerProfile {
  const ownedCharacterLevels: Record<string, number> = {};
  for (const id of STARTER_CHARACTER_IDS) ownedCharacterLevels[id] = 1;
  const ownedCardLevels: Record<string, number> = {};
  for (const id of CORE_DECK_CARD_IDS) ownedCardLevels[id] = 1;
  return {
    version: 1,
    currency: STARTING_CURRENCY,
    ownedCharacterLevels,
    ownedCardLevels,
    selectedCharacterId: STARTER_CHARACTER_IDS[0],
    selectedDeckCardIds: [],
    completedRuns: 0,
    clearedEncounters: 0,
  };
}

/** A new local collection starts with the four heroines and the basic eight-card deck. */
export function createPlayerProfile(): PlayerProfile {
  return starterProfile();
}

/**
 * Normalizes current and legacy profile JSON into the version 1 local format.
 * Unknown content is discarded and starter unlocks are always restored.
 */
export function migratePlayerProfile(input: unknown): PlayerProfile {
  const defaults = starterProfile();
  if (!isRecord(input)) return defaults;

  const ownedCharacterLevels = {
    ...defaults.ownedCharacterLevels,
    ...sanitizeLevels(input.ownedCharacterLevels ?? input.characters, ALL_CHARACTER_IDS),
  };
  const ownedCardLevels = {
    ...defaults.ownedCardLevels,
    ...sanitizeLevels(input.ownedCardLevels ?? input.cards, ALL_CARD_IDS),
  };

  const selectedCharacterId =
    typeof input.selectedCharacterId === "string" &&
    CHARACTER_BY_ID.has(input.selectedCharacterId) &&
    ownedCharacterLevels[input.selectedCharacterId] !== undefined
      ? input.selectedCharacterId
      : defaults.selectedCharacterId;

  const candidateDeck = Array.isArray(input.selectedDeckCardIds)
    ? input.selectedDeckCardIds.filter((id): id is string => typeof id === "string")
    : [];

  const profile: PlayerProfile = {
    version: 1,
    currency: safeInteger(input.currency, defaults.currency),
    ownedCharacterLevels,
    ownedCardLevels,
    selectedCharacterId,
    selectedDeckCardIds: [],
    completedRuns: safeInteger(input.completedRuns),
    clearedEncounters: safeInteger(input.clearedEncounters),
  };

  if (isValidDeckSelection(candidateDeck, profile.ownedCardLevels)) {
    profile.selectedDeckCardIds = [...candidateDeck];
  }
  return profile;
}

/** Checks that a chosen eight-card deck uses no more than four collection cards. */
export function isValidDeckSelection(cardIds: readonly string[], ownedCardLevels: Record<string, number>): boolean {
  if (cardIds.length !== DECK_SIZE || new Set(cardIds).size !== DECK_SIZE) return false;
  if (cardIds.some((id) => !CARD_BY_ID.has(id) || (ownedCardLevels[id] ?? 0) < 1)) return false;
  const replacements = cardIds.filter((id) => !STARTER_CARD_SET.has(id)).length;
  return replacements <= MAX_REPLACEMENT_CARDS;
}

function sample(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999999999, Math.max(0, value));
}

/**
 * Draws one permanent character or card. The RNG is injectable for reproducible
 * tests; the live default is an independent uniform draw with no pity state.
 */
export function drawFromPool(
  sourceProfile: PlayerProfile,
  pool: PoolKind,
  random: () => number = Math.random,
): GachaResult {
  const profile = migratePlayerProfile(sourceProfile);
  if (profile.currency < GACHA_COST) {
    return {
      profile,
      error: { code: "insufficient-currency", message: "星晶不足，抽卡需要 100 星晶。" },
    };
  }

  const items = pool === "character" ? PULLABLE_CHARACTERS : PULLABLE_CARDS;
  const rarityRoll = sample(random);
  const rarity = rarityRoll < RARITY_ODDS.common ? "common" : rarityRoll < RARITY_ODDS.common + RARITY_ODDS.rare ? "rare" : "epic";
  const rarityItems = items.filter((item) => item.rarity === rarity);
  const chosen = rarityItems[Math.floor(sample(random) * rarityItems.length)];
  // Both configured pools contain entries at each rarity. Keep the fallback for
  // future content edits so a missing tier cannot silently break a local save.
  const dropItem = chosen ?? items[Math.floor(sample(random) * items.length)];
  if (!dropItem) return { profile, error: { code: "insufficient-currency", message: "目前沒有可抽取的內容。" } };

  profile.currency -= GACHA_COST;
  const levels = pool === "character" ? profile.ownedCharacterLevels : profile.ownedCardLevels;
  const previousLevel = levels[dropItem.id] ?? 0;
  let refunded = 0;
  let level = previousLevel;
  if (previousLevel >= MAX_COLLECTION_LEVEL) {
    refunded = GACHA_DUPLICATE_REFUND;
    profile.currency += refunded;
  } else {
    level = previousLevel + 1;
    levels[dropItem.id] = level;
  }

  return {
    profile,
    drop: {
      pool,
      id: dropItem.id,
      name: dropItem.name,
      rarity: dropItem.rarity,
      level,
      upgraded: previousLevel > 0 && previousLevel < MAX_COLLECTION_LEVEL,
      refunded,
    },
  };
}

export function collectionCardValue(cardId: string, level: number): number {
  const card = CARD_BY_ID.get(cardId);
  const mainEffect = card?.effects[0];
  return mainEffect ? scaledStat(mainEffect.amount, level) : 0;
}

/** Convenience helpers for UI and server validation. */
export function isKnownCharacter(id: string): boolean {
  return CHARACTER_BY_ID.has(id);
}

export function isKnownCard(id: string): boolean {
  return CARD_BY_ID.has(id);
}

export function getCharacterLevel(profile: PlayerProfile, id: string): number {
  return profile.ownedCharacterLevels[id] ?? 0;
}

export function getCardLevel(profile: PlayerProfile, id: string): number {
  return profile.ownedCardLevels[id] ?? 0;
}
