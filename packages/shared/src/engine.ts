import {
  CARD_BY_ID,
  CHARACTER_BY_ID,
  CORE_DECK_CARD_IDS,
  PULLABLE_CARDS,
  scaledStat,
} from "./content.js";
import {
  INITIAL_HAND_SIZE,
  MAX_HAND_SIZE,
  createPlayerProfile,
  isValidDeckSelection,
  migratePlayerProfile,
} from "./profile.js";
import type {
  CardEffect,
  CardTarget,
  CharacterDefinition,
  HeroPassive,
} from "./content.js";
import type {
  EngineResult,
  GameAction,
  GameEngine,
  GameView,
  PlayerProfile,
  PlayerView,
} from "./protocol.js";

export interface GamePlayerState {
  id: string;
  displayName: string;
  connected: boolean;
  inRun: boolean;
  isReady: boolean;
  characterId: string | null;
  hp: number;
  maxHp: number;
  block: number;
  energy: number;
  maxEnergy: number;
  profile: PlayerProfile;
  runDeck: string[];
  drawPile: string[];
  hand: string[];
  discardPile: string[];
  selectedCardIds: string[];
  selectedTargets: string[];
  rewardChoice: string | null;
}

export type EnemyIntentKind = "attack" | "attack-all" | "guard";

export interface GameEnemyState {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  block: number;
  intentKind: EnemyIntentKind;
  intentValue: number;
  targetPlayerId: string | null;
}

export interface StarwishGameState {
  protocolVersion: 1;
  roomCode: string;
  phase: GameView["phase"];
  encounterIndex: number;
  round: number;
  players: GamePlayerState[];
  enemies: GameEnemyState[];
  rewardOptions: string[];
  battleLog: string[];
  hostPlayerId: string;
  randomSeed: number;
}

const MAX_ROUNDS_PER_ENCOUNTER = 12;
const REGULAR_REWARD = 30;
const BOSS_REWARD = 60;
const MAX_BATTLE_LOG = 80;
const ALL_ENEMIES_TARGET = "all-enemies";

interface EncounterDefinition {
  name: string;
  hp: number;
  attack: number;
  boss?: boolean;
}

const ENCOUNTERS: readonly EncounterDefinition[] = [
  { name: "棉絮精靈", hp: 24, attack: 5 },
  { name: "鏡面蛾", hp: 30, attack: 6 },
  { name: "暮影獵犬", hp: 38, attack: 7 },
  { name: "噩夢核心", hp: 66, attack: 8, boss: true },
];

function cloneState(state: StarwishGameState): StarwishGameState {
  return structuredClone(state) as StarwishGameState;
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash || 0x6d2b79f5;
}

function random(state: StarwishGameState): number {
  state.randomSeed = (state.randomSeed + 0x6d2b79f5) | 0;
  let value = state.randomSeed;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function shuffle<T>(state: StarwishGameState, values: readonly T[]): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random(state) * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

function failure(state: StarwishGameState, code: string, message: string): EngineResult<StarwishGameState> {
  return { state, error: { code, message } };
}

function addLog(state: StarwishGameState, message: string): void {
  state.battleLog.push(message);
  if (state.battleLog.length > MAX_BATTLE_LOG) state.battleLog.splice(0, state.battleLog.length - MAX_BATTLE_LOG);
}

function getPlayer(state: StarwishGameState, id: string): GamePlayerState | undefined {
  return state.players.find((player) => player.id === id);
}

function getCharacter(player: GamePlayerState): CharacterDefinition | undefined {
  return player.characterId ? CHARACTER_BY_ID.get(player.characterId) : undefined;
}

function characterLevel(player: GamePlayerState): number {
  return player.characterId ? player.profile.ownedCharacterLevels[player.characterId] ?? 1 : 1;
}

function cardLevel(player: GamePlayerState, cardId: string): number {
  return player.profile.ownedCardLevels[cardId] ?? 1;
}

function characterStats(characterId: string | null, profile: PlayerProfile): { maxHp: number; maxEnergy: number } {
  const character = characterId ? CHARACTER_BY_ID.get(characterId) : undefined;
  if (!character) return { maxHp: 40, maxEnergy: 3 };
  const level = profile.ownedCharacterLevels[characterId!] ?? 1;
  return { maxHp: scaledStat(character.maxHp, level), maxEnergy: character.maxEnergy };
}

function validCardTarget(
  state: StarwishGameState,
  player: GamePlayerState,
  targetKind: CardTarget,
  targetId: string,
): boolean {
  switch (targetKind) {
    case "enemy":
      return state.enemies.some((enemy) => enemy.id === targetId && enemy.hp > 0);
    case "all-enemies":
      return targetId === ALL_ENEMIES_TARGET;
    case "ally":
      return state.players.some((candidate) => candidate.inRun && candidate.hp > 0 && candidate.id === targetId);
    case "self":
      return targetId === player.id || targetId === "self";
  }
}

function setIntent(state: StarwishGameState, enemy: GameEnemyState): void {
  const encounter = ENCOUNTERS[state.encounterIndex] ?? ENCOUNTERS[0]!;
  const livingPlayers = state.players.filter((player) => player.inRun && player.hp > 0);
  const target = [...livingPlayers].sort((left, right) => {
    const leftRatio = left.hp / Math.max(1, left.maxHp);
    const rightRatio = right.hp / Math.max(1, right.maxHp);
    return leftRatio - rightRatio || left.id.localeCompare(right.id);
  })[0];

  enemy.targetPlayerId = target?.id ?? null;
  if (encounter.boss) {
    if (state.round % 4 === 3) {
      enemy.intentKind = "guard";
      enemy.intentValue = 9;
    } else if (state.round % 4 === 1) {
      enemy.intentKind = "attack-all";
      enemy.intentValue = encounter.attack;
    } else {
      enemy.intentKind = "attack";
      enemy.intentValue = encounter.attack;
    }
  } else if (state.round % 3 === 2) {
    enemy.intentKind = "guard";
    enemy.intentValue = 4 + Math.floor(state.encounterIndex / 2);
  } else {
    enemy.intentKind = "attack";
    enemy.intentValue = encounter.attack;
  }
}

function describeIntent(state: StarwishGameState, enemy: GameEnemyState): string {
  if (enemy.intentKind === "guard") return "準備護盾";
  if (enemy.intentKind === "attack-all") return "全體攻擊";
  const target = enemy.targetPlayerId ? getPlayer(state, enemy.targetPlayerId) : undefined;
  return target ? `攻擊 ${target.displayName}` : "單體攻擊";
}

function shuffleDiscardIntoDraw(state: StarwishGameState, player: GamePlayerState): void {
  if (player.drawPile.length > 0 || player.discardPile.length === 0) return;
  player.drawPile = shuffle(state, player.discardPile);
  player.discardPile = [];
}

function drawCards(state: StarwishGameState, player: GamePlayerState, amount: number): number {
  let drawn = 0;
  while (drawn < amount && player.hand.length < MAX_HAND_SIZE) {
    shuffleDiscardIntoDraw(state, player);
    const cardId = player.drawPile.shift();
    if (!cardId) break;
    player.hand.push(cardId);
    drawn += 1;
  }
  return drawn;
}

function lowestHpAlly(state: StarwishGameState, player: GamePlayerState): GamePlayerState {
  const living = state.players.filter((candidate) => candidate.inRun && candidate.hp > 0);
  return [...living].sort((left, right) => {
    const leftRatio = left.hp / Math.max(1, left.maxHp);
    const rightRatio = right.hp / Math.max(1, right.maxHp);
    return leftRatio - rightRatio || left.id.localeCompare(right.id);
  })[0] ?? player;
}

function applyPassive(state: StarwishGameState, player: GamePlayerState, passive: HeroPassive, level: number): void {
  const amount = scaledStat(passive.amount, level);
  switch (passive.kind) {
    case "block":
      player.block += amount;
      addLog(state, `${player.displayName} 的星輝被動獲得 ${amount} 點護盾。`);
      break;
    case "damage":
      // Applied when this player's attacks resolve during this round.
      break;
    case "heal-self": {
      const before = player.hp;
      player.hp = Math.min(player.maxHp, player.hp + amount);
      if (player.hp > before) addLog(state, `${player.displayName} 恢復 ${player.hp - before} 點生命。`);
      break;
    }
    case "heal-lowest-ally": {
      const target = lowestHpAlly(state, player);
      const before = target.hp;
      target.hp = Math.min(target.maxHp, target.hp + amount);
      if (target.hp > before) addLog(state, `${player.displayName} 治療 ${target.displayName} ${target.hp - before} 點生命。`);
      break;
    }
    case "draw": {
      const drawn = drawCards(state, player, amount);
      if (drawn > 0) addLog(state, `${player.displayName} 的星輝被動抽了 ${drawn} 張牌。`);
      break;
    }
  }
}

function prepareRound(state: StarwishGameState, isFirstRound: boolean): void {
  for (const player of state.players) {
    player.selectedCardIds = [];
    player.selectedTargets = [];
    player.rewardChoice = null;
    player.energy = 0;
    player.block = 0;
    player.isReady = !player.inRun || !player.connected || player.hp <= 0;
    if (!player.inRun || player.hp <= 0) continue;

    player.energy = player.maxEnergy;
    drawCards(state, player, isFirstRound ? INITIAL_HAND_SIZE : Math.max(0, INITIAL_HAND_SIZE - player.hand.length));
    const character = getCharacter(player);
    if (character) applyPassive(state, player, character.passive, characterLevel(player));
  }
  for (const enemy of state.enemies) setIntent(state, enemy);
}

function dealDamageToEnemy(state: StarwishGameState, enemy: GameEnemyState, amount: number): number {
  const blocked = Math.min(enemy.block, amount);
  enemy.block -= blocked;
  const damage = amount - blocked;
  enemy.hp = Math.max(0, enemy.hp - damage);
  return damage;
}

function dealDamageToPlayer(state: StarwishGameState, player: GamePlayerState, amount: number): number {
  const blocked = Math.min(player.block, amount);
  player.block -= blocked;
  const damage = amount - blocked;
  player.hp = Math.max(0, player.hp - damage);
  return damage;
}

function effectValue(effect: CardEffect, level: number): number {
  return scaledStat(effect.amount, level);
}

function executeEffect(
  state: StarwishGameState,
  player: GamePlayerState,
  effect: CardEffect,
  targetId: string,
  level: number,
  damageBonus: number,
): void {
  const amount = effectValue(effect, level);
  switch (effect.kind) {
    case "damage": {
      const targets = effect.target === "all-enemies"
        ? state.enemies.filter((enemy) => enemy.hp > 0)
        : state.enemies.filter((enemy) => enemy.id === targetId && enemy.hp > 0);
      for (const enemy of targets) {
        const dealt = dealDamageToEnemy(state, enemy, amount + damageBonus);
        addLog(state, `${player.displayName} 對 ${enemy.name} 造成 ${dealt} 點傷害。`);
      }
      break;
    }
    case "block": {
      const target = effect.target === "self" ? player : getPlayer(state, targetId);
      if (target?.inRun && target.hp > 0) {
        target.block += amount;
        addLog(state, `${player.displayName} 為 ${target.displayName} 增加 ${amount} 點護盾。`);
      }
      break;
    }
    case "heal": {
      const target = effect.target === "self"
        ? player
        : effect.target === "lowest-ally"
          ? lowestHpAlly(state, player)
          : getPlayer(state, targetId);
      if (target?.inRun && target.hp > 0) {
        const before = target.hp;
        target.hp = Math.min(target.maxHp, target.hp + amount);
        addLog(state, `${player.displayName} 治療 ${target.displayName} ${target.hp - before} 點生命。`);
      }
      break;
    }
    case "draw": {
      const drawn = drawCards(state, player, amount);
      addLog(state, `${player.displayName} 抽了 ${drawn} 張牌。`);
      break;
    }
  }
}

function resolveCard(state: StarwishGameState, player: GamePlayerState, cardId: string, targetId: string): void {
  const card = CARD_BY_ID.get(cardId);
  if (!card) return;
  const level = cardLevel(player, cardId);
  const character = getCharacter(player);
  const damageBonus = character?.passive.kind === "damage"
    ? scaledStat(character.passive.amount, characterLevel(player))
    : 0;

  addLog(state, `${player.displayName} 使用「${card.name}」${level > 1 ? ` Lv.${level}` : ""}。`);
  for (const effect of card.effects) executeEffect(state, player, effect, targetId, level, effect.kind === "damage" ? damageBonus : 0);
}

function removeOne(values: string[], value: string): boolean {
  const index = values.indexOf(value);
  if (index < 0) return false;
  values.splice(index, 1);
  return true;
}

function aliveInRun(state: StarwishGameState): GamePlayerState[] {
  return state.players.filter((player) => player.inRun && player.hp > 0);
}

function grantCurrency(state: StarwishGameState, amount: number, completedEncounter: boolean): void {
  for (const player of state.players) {
    if (!player.inRun) continue;
    player.profile.currency += amount;
    if (completedEncounter) player.profile.clearedEncounters += 1;
  }
}

function generateRewardOptions(state: StarwishGameState): string[] {
  return shuffle(state, PULLABLE_CARDS).slice(0, 3).map((card) => card.id);
}

function finishEncounter(state: StarwishGameState): void {
  const encounter = ENCOUNTERS[state.encounterIndex]!;
  if (encounter.boss) {
    grantCurrency(state, BOSS_REWARD, true);
    for (const player of state.players) {
      if (player.inRun) player.profile.completedRuns += 1;
    }
    state.phase = "victory";
    state.rewardOptions = [];
    state.enemies = [];
    addLog(state, `擊敗頭目！每位玩家獲得 ${BOSS_REWARD} 星晶，旅程完成。`);
    return;
  }

  grantCurrency(state, REGULAR_REWARD, true);
  state.phase = "reward";
  state.rewardOptions = generateRewardOptions(state);
  for (const player of state.players) {
    player.rewardChoice = player.inRun && !player.connected ? state.rewardOptions[0] ?? null : null;
    player.isReady = player.rewardChoice !== null;
  }
  state.enemies = [];
  addLog(state, `戰鬥勝利！每位玩家獲得 ${REGULAR_REWARD} 星晶，請選擇一張旅程卡。`);
  advanceIfRewardsChosen(state);
}

function allRewardsChosen(state: StarwishGameState): boolean {
  const participants = state.players.filter((player) => player.inRun && player.connected);
  return participants.length > 0 && participants.every((player) => player.rewardChoice !== null);
}

function beginEncounter(state: StarwishGameState, encounterIndex: number): void {
  const encounter = ENCOUNTERS[encounterIndex]!;
  state.phase = "combat";
  state.encounterIndex = encounterIndex;
  state.round = 1;
  state.rewardOptions = [];
  state.enemies = [];
  const partySize = Math.max(1, state.players.filter((player) => player.inRun).length);
  const hpMultiplier = 1 + 0.55 * (partySize - 1);
  const enemyHp = Math.round(encounter.hp * hpMultiplier);
  state.enemies.push({
    id: `${state.roomCode}-enc${encounterIndex + 1}-foe`,
    name: encounter.name,
    hp: enemyHp,
    maxHp: enemyHp,
    block: 0,
    intentKind: "attack",
    intentValue: encounter.attack,
    targetPlayerId: null,
  });

  for (const player of state.players) {
    player.block = 0;
    player.energy = 0;
    player.selectedCardIds = [];
    player.selectedTargets = [];
    player.rewardChoice = null;
    player.isReady = !player.inRun || !player.connected || player.hp <= 0;
    if (!player.inRun) continue;
    player.runDeck = player.runDeck.length > 0 ? [...player.runDeck] : [...player.profile.selectedDeckCardIds];
    player.drawPile = shuffle(state, player.runDeck);
    player.hand = [];
    player.discardPile = [];
    player.energy = player.maxEnergy;
  }
  prepareRound(state, true);
  addLog(state, `${encounterIndex + 1}/4 戰：${encounter.name} 出現。`);
}

function applyEnemyAction(state: StarwishGameState, enemy: GameEnemyState): void {
  if (enemy.intentKind === "guard") {
    enemy.block += enemy.intentValue;
    addLog(state, `${enemy.name} 獲得 ${enemy.intentValue} 點護盾。`);
    return;
  }

  const targets = enemy.intentKind === "attack-all"
    ? aliveInRun(state)
    : [
        getPlayer(state, enemy.targetPlayerId ?? "") ??
        [...aliveInRun(state)].sort((left, right) => left.hp - right.hp)[0],
      ].filter((player): player is GamePlayerState => player !== undefined && player.hp > 0);

  for (const target of targets) {
    const dealt = dealDamageToPlayer(state, target, enemy.intentValue);
    addLog(state, `${enemy.name} 攻擊 ${target.displayName}，造成 ${dealt} 點傷害。`);
  }
}

function resolveRound(state: StarwishGameState): void {
  for (const player of state.players) {
    if (!player.inRun || player.hp <= 0) continue;
    for (let index = 0; index < player.selectedCardIds.length; index += 1) {
      const cardId = player.selectedCardIds[index]!;
      if (!removeOne(player.hand, cardId)) continue;
      resolveCard(state, player, cardId, player.selectedTargets[index] ?? player.id);
      player.discardPile.push(cardId);
    }
    player.energy = 0;
  }

  state.enemies = state.enemies.filter((enemy) => enemy.hp > 0);
  if (state.enemies.length === 0) {
    finishEncounter(state);
    return;
  }

  for (const enemy of state.enemies) applyEnemyAction(state, enemy);
  const activeParticipants = state.players.filter((player) => player.inRun);
  if (activeParticipants.length > 0 && activeParticipants.every((player) => player.hp <= 0)) {
    state.phase = "defeat";
    state.rewardOptions = [];
    addLog(state, "所有魔法少女都失去行動能力，旅程失敗。已取得的星晶仍會保留。");
    return;
  }
  if (state.round >= MAX_ROUNDS_PER_ENCOUNTER) {
    state.phase = "defeat";
    state.rewardOptions = [];
    addLog(state, "戰鬥超過回合上限，隊伍撤退。已取得的星晶仍會保留。");
    return;
  }

  state.round += 1;
  prepareRound(state, false);
}

function allRoundPlayersReady(state: StarwishGameState): boolean {
  const connectedParticipants = state.players.filter((player) => player.inRun && player.connected);
  return connectedParticipants.length > 0 && connectedParticipants.every((player) => player.hp <= 0 || player.isReady);
}

function advanceIfRewardsChosen(state: StarwishGameState): void {
  if (!allRewardsChosen(state)) return;
  const participantChoices = state.players.filter((player) => player.inRun);
  for (const player of participantChoices) {
    const choice = player.rewardChoice ?? state.rewardOptions[0];
    if (choice) player.runDeck.push(choice);
  }
  const nextEncounter = state.encounterIndex + 1;
  if (nextEncounter >= ENCOUNTERS.length) {
    state.phase = "victory";
    return;
  }
  beginEncounter(state, nextEncounter);
}

function formatCardDescription(cardId: string, level: number): string {
  const card = CARD_BY_ID.get(cardId);
  if (!card || level <= 1) return card?.description ?? "未知卡牌";
  let description = card.description;
  for (const effect of card.effects) {
    description = description.replace(String(effect.amount), String(scaledStat(effect.amount, level)));
  }
  return description;
}

function cardView(player: GamePlayerState, cardId: string) {
  const card = CARD_BY_ID.get(cardId);
  if (!card) return undefined;
  const level = player.profile.ownedCardLevels[cardId] ?? 1;
  const value = card.effects[0] ? scaledStat(card.effects[0].amount, level) : 0;
  return {
    id: card.id,
    name: card.name,
    description: formatCardDescription(card.id, level),
    cost: card.cost,
    rarity: card.rarity,
    kind: card.kind,
    value,
    level,
    color: card.color,
  };
}

function publicPlayerView(player: GamePlayerState, lobbyView: boolean): PlayerView {
  const showStats = player.inRun || lobbyView;
  return {
    id: player.id,
    displayName: player.displayName,
    connected: player.connected,
    isReady: player.isReady,
    characterId: player.characterId,
    hp: showStats ? player.hp : 0,
    maxHp: player.maxHp,
    block: player.inRun ? player.block : 0,
    energy: showStats ? player.energy : 0,
    maxEnergy: player.maxEnergy,
    handCount: player.inRun ? player.hand.length : 0,
  };
}

function currentPlayerView(state: StarwishGameState, player: GamePlayerState): GameView["self"] {
  const hand = player.inRun
    ? player.hand.map((cardId) => cardView(player, cardId)).filter((card): card is NonNullable<typeof card> => card !== undefined)
    : [];
  const rewardOptions = state.rewardOptions.map((cardId) => cardView(player, cardId)).filter((card): card is NonNullable<typeof card> => card !== undefined);
  return {
    hand,
    deckCount: player.inRun ? player.drawPile.length : 0,
    discardCount: player.inRun ? player.discardPile.length : 0,
    selectedCardIds: player.inRun ? [...player.selectedCardIds] : [],
    selectedTargets: player.inRun ? [...player.selectedTargets] : [],
    currency: player.profile.currency,
    collection: structuredClone(player.profile),
    ownedCharacterLevels: { ...player.profile.ownedCharacterLevels },
    ownedCardLevels: { ...player.profile.ownedCardLevels },
  };
}

function makePlayer(playerId: string, displayName: string, profile: PlayerProfile): GamePlayerState {
  const normalized = migratePlayerProfile(profile);
  const characterId = normalized.selectedCharacterId;
  const stats = characterStats(characterId, normalized);
  const selectedDeckCardIds = isValidDeckSelection(normalized.selectedDeckCardIds, normalized.ownedCardLevels)
    ? [...normalized.selectedDeckCardIds]
    : [];
  const fallbackDeck = selectedDeckCardIds.length > 0
    ? selectedDeckCardIds
    : [...CORE_DECK_CARD_IDS];

  return {
    id: playerId,
    displayName: displayName.trim().slice(0, 24) || "星願旅人",
    connected: true,
    inRun: false,
    isReady: false,
    characterId,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    block: 0,
    energy: stats.maxEnergy,
    maxEnergy: stats.maxEnergy,
    profile: normalized,
    runDeck: fallbackDeck,
    drawPile: [],
    hand: [],
    discardPile: [],
    selectedCardIds: [],
    selectedTargets: [],
    rewardChoice: null,
  };
}

function ensurePlayerAction(state: StarwishGameState, playerId: string): GamePlayerState | EngineResult<StarwishGameState> {
  const player = getPlayer(state, playerId);
  if (!player) return failure(state, "unknown-player", "找不到這位玩家。請重新加入房間。");
  if (!player.connected) return failure(state, "disconnected", "玩家目前已離線，請重新連線後再操作。");
  return player;
}

function isEngineResult(value: GamePlayerState | EngineResult<StarwishGameState>): value is EngineResult<StarwishGameState> {
  return "state" in value;
}

function startRun(state: StarwishGameState, playerId: string): EngineResult<StarwishGameState> {
  if (playerId !== state.hostPlayerId || !getPlayer(state, playerId)?.connected) {
    return failure(state, "host-only", "只有在線房主可以開始旅程。");
  }
  if (state.phase !== "lobby" && state.phase !== "victory" && state.phase !== "defeat") {
    return failure(state, "wrong-phase", "目前無法開始新旅程。");
  }
  const next = cloneState(state);
  const participants = next.players.filter((player) => player.connected);
  if (participants.length < 1 || participants.length > 4) return failure(state, "invalid-party-size", "旅程需要 1 至 4 位在線玩家。");
  for (const player of participants) {
    if (!player.characterId || (player.profile.ownedCharacterLevels[player.characterId] ?? 0) < 1) {
      return failure(state, "character-required", `${player.displayName} 尚未選擇已解鎖角色。`);
    }
    if (!isValidDeckSelection(player.profile.selectedDeckCardIds, player.profile.ownedCardLevels) && player.profile.selectedDeckCardIds.length > 0) {
      return failure(state, "invalid-deck", `${player.displayName} 的牌組設定無效，請重新組牌。`);
    }
  }

  const participantIds = new Set(participants.map((player) => player.id));
  for (const player of next.players) {
    player.inRun = participantIds.has(player.id);
    player.isReady = !player.inRun;
    player.block = 0;
    player.selectedCardIds = [];
    player.selectedTargets = [];
    player.rewardChoice = null;
    player.hand = [];
    player.drawPile = [];
    player.discardPile = [];
    if (!player.inRun) {
      player.hp = 0;
      player.energy = 0;
      continue;
    }
    const stats = characterStats(player.characterId, player.profile);
    player.maxHp = stats.maxHp;
    player.hp = stats.maxHp;
    player.maxEnergy = stats.maxEnergy;
    player.energy = stats.maxEnergy;
    player.runDeck = player.profile.selectedDeckCardIds.length > 0
      ? [...player.profile.selectedDeckCardIds]
      : [...CORE_DECK_CARD_IDS];
  }
  next.battleLog = [];
  addLog(next, `${participants.length} 位魔法少女踏上星願旅程。`);
  beginEncounter(next, 0);
  return { state: next };
}

export const engine: GameEngine<StarwishGameState> = {
  createRoom(roomCode: string): StarwishGameState {
    const nonce = `${Date.now()}:${Math.random()}`;
    return {
      protocolVersion: 1,
      roomCode,
      phase: "lobby",
      encounterIndex: 0,
      round: 0,
      players: [],
      enemies: [],
      rewardOptions: [],
      battleLog: [],
      hostPlayerId: "",
      randomSeed: hashSeed(`${roomCode}:${nonce}`),
    };
  },

  join(state: StarwishGameState, playerId: string, displayName: string, profile: PlayerProfile): EngineResult<StarwishGameState> {
    if (!playerId.trim()) return failure(state, "invalid-player-id", "玩家識別碼無效。");
    const existing = getPlayer(state, playerId);
    const next = cloneState(state);
    if (existing) {
      const player = getPlayer(next, playerId)!;
      player.connected = true;
      if (next.phase === "combat" && player.inRun && player.hp > 0) player.isReady = false;
      if (displayName.trim()) player.displayName = displayName.trim().slice(0, 24);
      if (!next.hostPlayerId || !getPlayer(next, next.hostPlayerId)?.connected) next.hostPlayerId = playerId;
      const notices = player.inRun ? undefined : state.phase !== "lobby" ? ["目前旅程已開始，請在下一局加入。"] : undefined;
      return notices ? { state: next, notices } : { state: next };
    }

    if (state.phase !== "lobby") return failure(state, "run-in-progress", "旅程進行中，無法加入新座位。");
    if (state.players.length >= 4) return failure(state, "room-full", "房間最多可容納 4 位玩家。");
    const player = makePlayer(playerId, displayName, profile ?? createPlayerProfile());
    next.players.push(player);
    if (!next.hostPlayerId || !getPlayer(next, next.hostPlayerId)?.connected) next.hostPlayerId = playerId;
    return { state: next };
  },

  disconnect(state: StarwishGameState, playerId: string): EngineResult<StarwishGameState> {
    const existing = getPlayer(state, playerId);
    if (!existing) return failure(state, "unknown-player", "找不到這位玩家。");
    const next = cloneState(state);
    const player = getPlayer(next, playerId)!;
    player.connected = false;
    if (player.inRun && next.phase === "combat") player.isReady = true;
    if (next.hostPlayerId === playerId) {
      const replacement = next.players.find((candidate) => candidate.connected);
      if (replacement) next.hostPlayerId = replacement.id;
    }
    if (next.phase === "combat" && allRoundPlayersReady(next)) resolveRound(next);
    if (next.phase === "reward") {
      player.rewardChoice ??= next.rewardOptions[0] ?? null;
      advanceIfRewardsChosen(next);
    }
    return { state: next };
  },

  dispatch(state: StarwishGameState, playerId: string, action: GameAction): EngineResult<StarwishGameState> {
    if (action.type === "start-run") return startRun(state, playerId);

    const selected = ensurePlayerAction(state, playerId);
    if (isEngineResult(selected)) return selected;
    const current = selected;

    if (action.type === "select-character") {
      if (state.phase !== "lobby") return failure(state, "wrong-phase", "只能在大廳選擇角色。");
      const character = CHARACTER_BY_ID.get(action.characterId);
      if (!character || (current.profile.ownedCharacterLevels[action.characterId] ?? 0) < 1) {
        return failure(state, "character-locked", "這位角色尚未解鎖，請先抽卡取得。");
      }
      const next = cloneState(state);
      const player = getPlayer(next, playerId)!;
      player.characterId = action.characterId;
      player.profile.selectedCharacterId = action.characterId;
      const stats = characterStats(action.characterId, player.profile);
      player.maxHp = stats.maxHp;
      player.maxEnergy = stats.maxEnergy;
      player.hp = stats.maxHp;
      player.energy = stats.maxEnergy;
      return { state: next };
    }

    if (action.type === "set-deck") {
      if (state.phase !== "lobby") return failure(state, "wrong-phase", "只能在大廳設定牌組。");
      if (!isValidDeckSelection(action.cardIds, current.profile.ownedCardLevels)) {
        return failure(state, "invalid-deck", "牌組需有 8 張不同的已擁有卡牌，並最多替換 4 張基礎牌。");
      }
      const next = cloneState(state);
      const player = getPlayer(next, playerId)!;
      player.profile.selectedDeckCardIds = [...action.cardIds];
      player.runDeck = [...action.cardIds];
      return { state: next };
    }

    if (action.type === "submit-plan") {
      if (state.phase !== "combat") return failure(state, "wrong-phase", "現在不是戰鬥規劃階段。");
      if (!current.inRun || current.hp <= 0) return failure(state, "inactive-player", "目前無法行動。");
      if (current.isReady) return failure(state, "already-ready", "你已準備完成，等待隊友結算。");
      if (action.cardIds.length !== action.targets.length) return failure(state, "invalid-plan", "每張出牌都必須對應一個目標。");

      let totalCost = 0;
      const available = new Map<string, number>();
      for (const cardId of current.hand) available.set(cardId, (available.get(cardId) ?? 0) + 1);
      for (let index = 0; index < action.cardIds.length; index += 1) {
        const cardId = action.cardIds[index]!;
        const card = CARD_BY_ID.get(cardId);
        const count = available.get(cardId) ?? 0;
        if (!card || count < 1) return failure(state, "card-not-in-hand", `手牌中沒有「${card?.name ?? cardId}」。`);
        if (!validCardTarget(state, current, card.target, action.targets[index]!)) {
          return failure(state, "invalid-target", `「${card.name}」的目標無效。`);
        }
        available.set(cardId, count - 1);
        totalCost += card.cost;
      }
      if (totalCost > current.maxEnergy) return failure(state, "not-enough-energy", "所選卡牌超過本回合能量。");

      const next = cloneState(state);
      const player = getPlayer(next, playerId)!;
      player.selectedCardIds = [...action.cardIds];
      player.selectedTargets = [...action.targets];
      player.energy = player.maxEnergy - totalCost;
      return { state: next };
    }

    if (action.type === "ready") {
      if (state.phase !== "combat") return failure(state, "wrong-phase", "目前沒有可準備的戰鬥回合。");
      if (!current.inRun) return failure(state, "inactive-player", "你不在這一局的參戰名單中。");
      const next = cloneState(state);
      const player = getPlayer(next, playerId)!;
      player.isReady = true;
      if (allRoundPlayersReady(next)) resolveRound(next);
      return { state: next };
    }

    if (action.type === "choose-reward") {
      if (state.phase !== "reward") return failure(state, "wrong-phase", "目前沒有旅程卡可以選擇。");
      if (!current.inRun) return failure(state, "inactive-player", "你不在這一局的參戰名單中。");
      if (!state.rewardOptions.includes(action.cardId)) return failure(state, "invalid-reward", "這張卡不在本次獎勵選項中。");
      if (current.rewardChoice) return failure(state, "already-chosen", "你已經選好本場獎勵。");

      const next = cloneState(state);
      const player = getPlayer(next, playerId)!;
      player.rewardChoice = action.cardId;
      player.isReady = true;
      advanceIfRewardsChosen(next);
      return { state: next };
    }

    return failure(state, "unknown-action", "不支援的遊戲操作。");
  },

  viewFor(state: StarwishGameState, playerId: string): GameView {
    const self = getPlayer(state, playerId);
    if (!self) throw new Error(`Player ${playerId} is not in room ${state.roomCode}`);
    return {
      protocolVersion: 1,
      roomCode: state.roomCode,
      phase: state.phase,
      encounterIndex: state.encounterIndex,
      round: state.round,
      players: state.players.map((player) => publicPlayerView(player, state.phase === "lobby")),
      self: currentPlayerView(state, self),
      enemies: state.enemies.map((enemy) => ({
        id: enemy.id,
        name: enemy.name,
        hp: enemy.hp,
        maxHp: enemy.maxHp,
        block: enemy.block,
        intent: describeIntent(state, enemy),
        intentValue: enemy.intentValue,
      })),
      rewardOptions: state.rewardOptions
        .map((cardId) => cardView(self, cardId))
        .filter((card): card is NonNullable<typeof card> => card !== undefined),
      battleLog: [...state.battleLog],
      hostPlayerId: state.hostPlayerId,
    };
  },
};
