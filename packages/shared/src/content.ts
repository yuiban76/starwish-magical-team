import type { CardView } from "./protocol.js";

export type Rarity = CardView["rarity"];
export type CardKind = CardView["kind"];

export type CardTarget = "enemy" | "all-enemies" | "ally" | "self";

export type CardEffect =
  | { kind: "damage"; amount: number; target: "selected-enemy" | "all-enemies" }
  | { kind: "block"; amount: number; target: "self" | "selected-ally" }
  | { kind: "heal"; amount: number; target: "selected-ally" | "self" | "lowest-ally" }
  | { kind: "draw"; amount: number; target: "self" };

export interface CardDefinition {
  id: string;
  name: string;
  description: string;
  cost: number;
  rarity: Rarity;
  kind: CardKind;
  color: string;
  target: CardTarget;
  effects: CardEffect[];
  pullable: boolean;
}

export type HeroPassive =
  | { kind: "block"; amount: number }
  | { kind: "damage"; amount: number }
  | { kind: "heal-self"; amount: number }
  | { kind: "heal-lowest-ally"; amount: number }
  | { kind: "draw"; amount: number };

export interface CharacterDefinition {
  id: string;
  name: string;
  title: string;
  description: string;
  rarity: Rarity;
  maxHp: number;
  maxEnergy: number;
  color: string;
  passive: HeroPassive;
  pullable: boolean;
}

export const STARTER_CHARACTER_IDS = ["luna", "sol", "nova", "aria"] as const;
export const UNLOCKABLE_CHARACTER_IDS = ["yume", "akari", "nene", "ruri"] as const;

export const CHARACTERS: readonly CharacterDefinition[] = [
  {
    id: "luna",
    name: "露娜",
    title: "月光守護者",
    description: "每回合開始時，為自己獲得護盾。",
    rarity: "common",
    maxHp: 44,
    maxEnergy: 3,
    color: "#8f7df2",
    passive: { kind: "block", amount: 2 },
    pullable: false,
  },
  {
    id: "sol",
    name: "蘇爾",
    title: "烈陽劍士",
    description: "每回合開始時，攻擊會額外造成傷害。",
    rarity: "common",
    maxHp: 40,
    maxEnergy: 3,
    color: "#ff9b5e",
    passive: { kind: "damage", amount: 2 },
    pullable: false,
  },
  {
    id: "nova",
    name: "諾瓦",
    title: "星塵觀測者",
    description: "每回合開始時額外抽牌。",
    rarity: "common",
    maxHp: 36,
    maxEnergy: 4,
    color: "#55b9e8",
    passive: { kind: "draw", amount: 1 },
    pullable: false,
  },
  {
    id: "aria",
    name: "艾莉亞",
    title: "晨曦歌者",
    description: "每回合開始時治療自己。",
    rarity: "common",
    maxHp: 42,
    maxEnergy: 3,
    color: "#ed78ae",
    passive: { kind: "heal-self", amount: 2 },
    pullable: false,
  },
  {
    id: "yume",
    name: "夢羽",
    title: "夢境旅人",
    description: "每回合開始時，為自己獲得護盾。",
    rarity: "common",
    maxHp: 43,
    maxEnergy: 3,
    color: "#aa87dd",
    passive: { kind: "block", amount: 3 },
    pullable: true,
  },
  {
    id: "akari",
    name: "明里",
    title: "破曉之刃",
    description: "每回合開始時，攻擊會額外造成傷害。",
    rarity: "rare",
    maxHp: 39,
    maxEnergy: 3,
    color: "#ff6c69",
    passive: { kind: "damage", amount: 3 },
    pullable: true,
  },
  {
    id: "nene",
    name: "寧音",
    title: "星海療癒師",
    description: "每回合開始時，治療生命最低的隊友。",
    rarity: "common",
    maxHp: 40,
    maxEnergy: 3,
    color: "#60cfad",
    passive: { kind: "heal-lowest-ally", amount: 3 },
    pullable: true,
  },
  {
    id: "ruri",
    name: "琉璃",
    title: "水晶占星師",
    description: "每回合開始時額外抽牌。",
    rarity: "epic",
    maxHp: 35,
    maxEnergy: 4,
    color: "#6d9ff5",
    passive: { kind: "draw", amount: 2 },
    pullable: true,
  },
];

export const CORE_DECK_CARD_IDS = [
  "moonlight-strike",
  "comet-slash",
  "halo-guard",
  "prism-ward",
  "starlight-aid",
  "tiny-spark",
  "meditation",
  "celestial-mend",
] as const;

const makeCard = (
  id: string,
  name: string,
  description: string,
  cost: number,
  rarity: Rarity,
  kind: CardKind,
  color: string,
  target: CardTarget,
  effects: CardEffect[],
  pullable: boolean,
): CardDefinition => ({ id, name, description, cost, rarity, kind, color, target, effects, pullable });

export const CARDS: readonly CardDefinition[] = [
  makeCard("moonlight-strike", "月光斬", "造成 6 點傷害。", 1, "common", "attack", "#9b8cff", "enemy", [{ kind: "damage", amount: 6, target: "selected-enemy" }], false),
  makeCard("comet-slash", "彗星斬", "造成 9 點傷害。", 2, "common", "attack", "#ff9671", "enemy", [{ kind: "damage", amount: 9, target: "selected-enemy" }], false),
  makeCard("halo-guard", "光環守護", "獲得 7 點護盾。", 1, "common", "guard", "#72c7f1", "self", [{ kind: "block", amount: 7, target: "self" }], false),
  makeCard("prism-ward", "稜鏡屏障", "獲得 5 點護盾。", 1, "common", "guard", "#70dfc1", "ally", [{ kind: "block", amount: 5, target: "selected-ally" }], false),
  makeCard("starlight-aid", "星光療癒", "治療一名隊友 5 點生命。", 1, "common", "support", "#f08bc0", "ally", [{ kind: "heal", amount: 5, target: "selected-ally" }], false),
  makeCard("tiny-spark", "微光彈", "造成 4 點傷害。", 0, "common", "attack", "#ffc36d", "enemy", [{ kind: "damage", amount: 4, target: "selected-enemy" }], false),
  makeCard("meditation", "靜心", "抽 1 張牌。", 0, "common", "support", "#7ecbd6", "self", [{ kind: "draw", amount: 1, target: "self" }], false),
  makeCard("celestial-mend", "天穹祝福", "治療一名隊友 8 點生命。", 2, "common", "support", "#e881b5", "ally", [{ kind: "heal", amount: 8, target: "selected-ally" }], false),

  // 20 cards in the permanent card pool: 12 common, 6 rare, and 2 epic.
  makeCard("spark-jab", "星火突刺", "造成 4 點傷害。", 0, "common", "attack", "#ffbf69", "enemy", [{ kind: "damage", amount: 4, target: "selected-enemy" }], true),
  makeCard("moonbeam", "月弧光束", "造成 7 點傷害。", 1, "common", "attack", "#9e91f5", "enemy", [{ kind: "damage", amount: 7, target: "selected-enemy" }], true),
  makeCard("petal-volley", "花瓣連射", "造成 6 點傷害。", 1, "common", "attack", "#f38eb4", "enemy", [{ kind: "damage", amount: 6, target: "selected-enemy" }], true),
  makeCard("mirror-curtain", "鏡光幕", "獲得 8 點護盾。", 1, "common", "guard", "#72c7f1", "self", [{ kind: "block", amount: 8, target: "self" }], true),
  makeCard("quick-ward", "瞬間結界", "為一名隊友獲得 5 點護盾。", 0, "common", "guard", "#70dfc1", "ally", [{ kind: "block", amount: 5, target: "selected-ally" }], true),
  makeCard("heart-mend", "心之療癒", "治療一名隊友 7 點生命。", 1, "common", "support", "#ed82b5", "ally", [{ kind: "heal", amount: 7, target: "selected-ally" }], true),
  makeCard("rally-note", "勇氣樂章", "治療一名隊友 5 點生命。", 1, "common", "support", "#e6a1da", "ally", [{ kind: "heal", amount: 5, target: "selected-ally" }], true),
  makeCard("arcane-focus", "魔力凝視", "抽 2 張牌。", 0, "common", "support", "#7ecbd6", "self", [{ kind: "draw", amount: 2, target: "self" }], true),
  makeCard("moon-blessing", "月之恩典", "為一名隊友獲得 7 點護盾。", 1, "common", "guard", "#8eb6f3", "ally", [{ kind: "block", amount: 7, target: "selected-ally" }], true),
  makeCard("meteor-impact", "流星撞擊", "造成 14 點傷害。", 2, "common", "attack", "#ff986f", "enemy", [{ kind: "damage", amount: 14, target: "selected-enemy" }], true),
  makeCard("aurora-spear", "極光長矛", "造成 11 點傷害。", 2, "common", "attack", "#70d7d0", "enemy", [{ kind: "damage", amount: 11, target: "selected-enemy" }], true),
  makeCard("crystal-song", "水晶歌謠", "治療一名隊友 10 點生命。", 2, "common", "support", "#83cdbd", "ally", [{ kind: "heal", amount: 10, target: "selected-ally" }], true),

  makeCard("eclipse-ray", "日蝕射線", "造成 16 點傷害。", 2, "rare", "attack", "#7167bb", "enemy", [{ kind: "damage", amount: 16, target: "selected-enemy" }], true),
  makeCard("comet-storm", "彗星風暴", "造成 22 點傷害。", 3, "rare", "attack", "#ff815f", "enemy", [{ kind: "damage", amount: 22, target: "selected-enemy" }], true),
  makeCard("guardian-star", "守護星盾", "為一名隊友獲得 15 點護盾。", 2, "rare", "guard", "#6cbbe5", "ally", [{ kind: "block", amount: 15, target: "selected-ally" }], true),
  makeCard("healing-chorus", "療癒合唱", "治療一名隊友 12 點生命。", 2, "rare", "support", "#e883b2", "ally", [{ kind: "heal", amount: 12, target: "selected-ally" }], true),
  makeCard("twin-focus", "雙重凝神", "抽 3 張牌。", 1, "rare", "support", "#75cbd6", "self", [{ kind: "draw", amount: 3, target: "self" }], true),
  makeCard("starfall", "群星墜落", "對所有敵人造成 12 點傷害。", 3, "rare", "attack", "#8f86dd", "all-enemies", [{ kind: "damage", amount: 12, target: "all-enemies" }], true),

  makeCard("astral-nova", "星界新星", "對所有敵人造成 20 點傷害。", 3, "epic", "attack", "#9e74ed", "all-enemies", [{ kind: "damage", amount: 20, target: "all-enemies" }], true),
  makeCard("celestial-bloom", "天穹綻放", "治療一名隊友 14 點，並獲得 8 點護盾。", 3, "epic", "support", "#f28db4", "ally", [
    { kind: "heal", amount: 14, target: "selected-ally" },
    { kind: "block", amount: 8, target: "self" },
  ], true),
];

export const CHARACTER_BY_ID: ReadonlyMap<string, CharacterDefinition> = new Map(CHARACTERS.map((character) => [character.id, character]));
export const CARD_BY_ID: ReadonlyMap<string, CardDefinition> = new Map(CARDS.map((card) => [card.id, card]));
export const STARTER_CHARACTER_SET: ReadonlySet<string> = new Set(STARTER_CHARACTER_IDS);
export const STARTER_CARD_SET: ReadonlySet<string> = new Set(CORE_DECK_CARD_IDS);
export const PULLABLE_CHARACTERS: readonly CharacterDefinition[] = CHARACTERS.filter((character) => character.pullable);
export const PULLABLE_CARDS: readonly CardDefinition[] = CARDS.filter((card) => card.pullable);

export const GACHA_COST = 100;
export const GACHA_DUPLICATE_REFUND = 25;
export const MAX_COLLECTION_LEVEL = 3;
export const STARTING_CURRENCY = 100;

export const RARITY_ODDS = {
  common: 0.6,
  rare: 0.3,
  epic: 0.1,
} as const;

export function scaledStat(base: number, level: number): number {
  const multiplier = level <= 1 ? 1 : level === 2 ? 1.2 : 1.4;
  return Math.max(0, Math.round(base * multiplier));
}
