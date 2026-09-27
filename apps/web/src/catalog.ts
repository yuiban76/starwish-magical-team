import {
  CARDS as gameCards,
  CHARACTERS as gameCharacters,
  CORE_DECK_CARD_IDS,
  createPlayerProfile,
  migratePlayerProfile,
} from "@starwish/shared";
import type { CardView, PlayerProfile } from "@starwish/shared";

const portraitImages: Record<string, string> = {
  luna: "luna-portrait.png",
  sol: "rose-guardian.png",
  nova: "nova-portrait.png",
  aria: "aria-portrait.png",
  yume: "yume-portrait.png",
  nene: "nene-portrait.png",
  akari: "akari-portrait.png",
  ruri: "ruri-portrait.png",
};

export const characters = gameCharacters.map((character) => ({
  ...character,
  portraitImage: `/assets/${portraitImages[character.id]}`,
  summary: character.description,
  element: character.id === "luna" ? "月" : character.id === "sol" ? "日" : character.id === "nova" ? "星" : character.id === "aria" ? "光" : "夢",
}));

export const cards = gameCards.map((card) => ({
  ...card,
  value: card.effects[0]?.amount ?? 0,
  portrait: card.id.replaceAll("-", ""),
}));

export const characterPoolIds = characters.filter((character) => character.pullable).map((character) => character.id);
export const cardPoolIds = cards.filter((card) => card.pullable).map((card) => card.id);
export const initialDeckIds: string[] = [...CORE_DECK_CARD_IDS];

const savedProfileKey = "starwish.profile.v1";

export function createProfile(): PlayerProfile {
  return { ...createPlayerProfile(), selectedDeckCardIds: [...initialDeckIds] };
}

export function readProfile(): PlayerProfile {
  try {
    const serialized = localStorage.getItem(savedProfileKey);
    if (serialized) {
      const profile = migratePlayerProfile(JSON.parse(serialized));
      return { ...profile, selectedDeckCardIds: profile.selectedDeckCardIds.length ? profile.selectedDeckCardIds : [...initialDeckIds] };
    }
  } catch {
    // Damaged or outdated local data becomes a clean starter collection.
  }
  return createProfile();
}

export function saveProfile(profile: PlayerProfile): void {
  localStorage.setItem(savedProfileKey, JSON.stringify(profile));
}

export function cardView(id: string, profile: PlayerProfile): CardView | undefined {
  const card = cards.find((item) => item.id === id);
  if (!card) return undefined;
  return {
    id: card.id,
    name: card.name,
    description: card.description,
    cost: card.cost,
    rarity: card.rarity,
    kind: card.kind,
    value: card.value,
    level: profile.ownedCardLevels[id] ?? 1,
    color: card.color,
  };
}

export function rarityName(rarity: string): string {
  return rarity === "epic" ? "史詩" : rarity === "rare" ? "稀有" : "普通";
}

export function levelText(level: number): string {
  return `Lv.${Math.min(3, Math.max(1, level))}`;
}
