export type PoolKind = "character" | "card";
export type GamePhase = "lobby" | "combat" | "reward" | "victory" | "defeat";

export type GameCommand =
  | { type: "join"; displayName: string; resumeToken?: string }
  | { type: "select-character"; characterId: string }
  | { type: "set-deck"; cardIds: string[] }
  | { type: "start-run" }
  | { type: "submit-plan"; cardIds: string[]; targets: string[] }
  | { type: "ready" }
  | { type: "choose-reward"; cardId: string }
  | { type: "draw"; pool: PoolKind }
  | { type: "leave" };

export type ServerMessage =
  | { type: "connected"; playerId: string; resumeToken: string; roomCode: string; protocolVersion: 1 }
  | { type: "state"; view: GameView }
  | { type: "error"; code: string; message: string }
  | { type: "notice"; message: string };

export interface GameView {
  protocolVersion: 1;
  roomCode: string;
  phase: GamePhase;
  encounterIndex: number;
  round: number;
  players: PlayerView[];
  self: SelfView;
  enemies: EnemyView[];
  rewardOptions: CardView[];
  battleLog: string[];
  hostPlayerId: string;
}

export interface PlayerView {
  id: string;
  displayName: string;
  connected: boolean;
  isReady: boolean;
  characterId: string | null;
  hp: number;
  maxHp: number;
  block: number;
  energy: number;
  maxEnergy: number;
  handCount: number;
}

export interface SelfView {
  hand: CardView[];
  deckCount: number;
  discardCount: number;
  selectedCardIds: string[];
  selectedTargets: string[];
  currency: number;
  collection: PlayerProfile;
  ownedCharacterLevels: Record<string, number>;
  ownedCardLevels: Record<string, number>;
}

export interface EnemyView {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  block: number;
  intent: string;
  intentValue: number;
}

export interface CardView {
  id: string;
  name: string;
  description: string;
  cost: number;
  rarity: "common" | "rare" | "epic";
  kind: "attack" | "guard" | "support";
  value: number;
  level: number;
  color: string;
}

export interface PlayerProfile {
  version: 1;
  currency: number;
  ownedCharacterLevels: Record<string, number>;
  ownedCardLevels: Record<string, number>;
  selectedCharacterId: string;
  selectedDeckCardIds: string[];
  completedRuns: number;
  clearedEncounters: number;
}
