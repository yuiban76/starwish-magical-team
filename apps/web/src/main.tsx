import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent, FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { drawFromPool, engine, GACHA_COST, migratePlayerProfile, RARITY_ODDS } from "@starwish/shared";
import type { CardView, GameAction, GameCommand, GameView, PlayerProfile, ServerMessage, StarwishGameState } from "@starwish/shared";
import { cardPoolIds, cardView, cards, characters, characterPoolIds, createProfile, initialDeckIds, levelText, rarityName, readProfile, saveProfile } from "./catalog.js";
import "./style.css";

type Route = "home" | "room" | "battle" | "summon" | "collection";
type ConnectionStatus = "offline" | "connecting" | "connected" | "demo";
type Toast = { kind: "error" | "success" | "info"; message: string };

const routeNames: Record<Route, string> = { home: "遠征大廳", room: "隊伍整備", battle: "星夜戰場", summon: "星願召喚", collection: "收藏檔案" };
function readRoute(): Route {
  const candidate = window.location.hash.replace(/^#\/?/, "") as Route;
  return candidate in routeNames ? candidate : "home";
}

function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const navigate = useCallback((next: Route) => {
    if (readRoute() !== next) window.location.hash = `/${next}`;
    else setRoute(next);
  }, []);
  return [route, navigate];
}

function CharacterPortrait({ characterId, size = "normal" }: { characterId: string; size?: "normal" | "small" | "large" }) {
  const character = characters.find((item) => item.id === characterId) ?? characters[0]!;
  return (
    <div
      className={`character-portrait character-portrait--${size}`}
      style={{
        "--portrait-color": character.color,
      } as CSSProperties}
      role="img"
      aria-label={`原創角色 ${character.name} 立繪`}
    >
      <div className="character-portrait__image"><img src={character.portraitImage} alt="" aria-hidden="true" loading="lazy" decoding="async" /></div>
      <span className="character-portrait__sigil" aria-hidden="true">✦</span>
    </div>
  );
}

function GameCard({
  card,
  selected = false,
  disabled = false,
  compact = false,
  onClick,
  label,
}: {
  card: CardView;
  selected?: boolean;
  disabled?: boolean;
  compact?: boolean;
  onClick?: () => void;
  label?: string;
}) {
  const icon = card.kind === "attack" ? "✦" : card.kind === "guard" ? "◈" : "❋";
  const content = (
    <>
      <div className="game-card__art" style={{ "--card-color": card.color } as CSSProperties}>
        <span className="game-card__art-glyph" aria-hidden="true">{icon}</span>
        <span className="game-card__level">{levelText(card.level)}</span>
        <span className="game-card__rarity">{rarityName(card.rarity)}</span>
      </div>
      <div className="game-card__copy">
        <div className="game-card__title-row">
          <h3>{card.name}</h3>
          <span className="game-card__cost" aria-label={`消耗 ${card.cost} 點能量`}>{card.cost}</span>
        </div>
        <p>{card.description}</p>
      </div>
      {label && <span className="game-card__footnote">{label}</span>}
    </>
  );
  if (!onClick) return <article className={`game-card ${compact ? "game-card--compact" : ""}`} data-rarity={card.rarity}>{content}</article>;
  return (
    <button
      type="button"
      className={`game-card game-card--interactive ${compact ? "game-card--compact" : ""} ${selected ? "is-selected" : ""}`}
      data-rarity={card.rarity}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

function App() {
  const [route, navigate] = useRoute();
  const [profile, setProfile] = useState<PlayerProfile>(() => readProfile());
  const [displayName, setDisplayName] = useState(() => localStorage.getItem("starwish.displayName") ?? "星旅人");
  const [view, setView] = useState<GameView | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("offline");
  const [playerId, setPlayerId] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [roomCodeInput, setRoomCodeInput] = useState("");
  const [addresses, setAddresses] = useState<Array<{ kind: "local" | "hamachi"; ip: string; url: string }>>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pool, setPool] = useState<"character" | "card">("character");
  const [lastDrop, setLastDrop] = useState<{ id: string; name: string; rarity: string; level: number; upgraded: boolean; refunded: number; pool: "character" | "card" } | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [summonRarity, setSummonRarity] = useState<"common" | "rare" | "epic">("common");
  const [battleSelection, setBattleSelection] = useState<string[]>([]);
  const [targetId, setTargetId] = useState("");
  const [importError, setImportError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);
  const manualCloseRef = useRef(false);
  const demoRef = useRef(false);
  const profileRef = useRef(profile);
  const localEngineStateRef = useRef<StarwishGameState | null>(null);
  const summonTimerRef = useRef<number | null>(null);
  const summonLockedRef = useRef(false);

  useEffect(() => {
    profileRef.current = profile;
    saveProfile(profile);
  }, [profile]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => () => {
    manualCloseRef.current = true;
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    if (summonTimerRef.current !== null) window.clearTimeout(summonTimerRef.current);
    socketRef.current?.close();
  }, []);

  const ownedCharacterIds = useMemo(() => Object.keys(profile.ownedCharacterLevels).filter((id) => profile.ownedCharacterLevels[id]! > 0), [profile]);
  const ownedCardIds = useMemo(() => Object.keys(profile.ownedCardLevels).filter((id) => profile.ownedCardLevels[id]! > 0), [profile]);
  const selectedCharacter = characters.find((item) => item.id === profile.selectedCharacterId) ?? characters[0]!;
  const displayCurrency = view && connection === "connected" ? view.self.currency : profile.currency;
  const canSummonNow = connection === "offline" && view === null || connection === "demo" && view?.phase === "lobby";

  const pushToast = useCallback((message: string, kind: Toast["kind"] = "info") => setToast({ message, kind }), []);

  const setLocalProfile = useCallback((next: PlayerProfile) => {
    setProfile(next);
    saveProfile(next);
    if (demoRef.current) {
      const state = localEngineStateRef.current;
      if (state?.phase === "lobby") {
        const freshState = engine.createRoom(state.roomCode);
        const joined = engine.join(freshState, "solo-player", displayName || "星旅人", next);
        localEngineStateRef.current = joined.state;
        setView(engine.viewFor(joined.state, "solo-player"));
      } else {
        setView((current) => current ? { ...current, self: { ...current.self, currency: next.currency, collection: next, ownedCardLevels: next.ownedCardLevels, ownedCharacterLevels: next.ownedCharacterLevels } } : current);
      }
    }
  }, [displayName]);

  const connectRoom = useCallback((code: string, isRetry = false) => {
    if (!code.trim()) {
      pushToast("請輸入房間代碼。", "error");
      return;
    }
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    const oldSocket = socketRef.current;
    socketRef.current = null;
    manualCloseRef.current = true;
    oldSocket?.close();
    manualCloseRef.current = false;
    const normalizedCode = code.trim().toUpperCase();
    setRoomCode(normalizedCode);
    setConnection("connecting");
    demoRef.current = false;
    if (!isRetry) retryCountRef.current = 0;
    const resumeToken = localStorage.getItem(`starwish.resume.${normalizedCode}`) ?? undefined;
    const url = new URL("/ws", window.location.href);
    url.searchParams.set("room", normalizedCode);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      setConnection("offline");
      pushToast("無法連線到房間伺服器。可稍後重試，或先啟動練習模式。", "error");
      return;
    }
    socketRef.current = socket;
    socket.onopen = () => {
      const command: GameCommand = { type: "join", displayName: displayName.trim() || "星旅人", profile: profileRef.current, ...(resumeToken ? { resumeToken } : {}) };
      socket.send(JSON.stringify(command));
      setConnection("connecting");
    };
    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        pushToast("收到無法讀取的伺服器訊息。", "error");
        return;
      }
      if (message.type === "connected") {
        setConnection("connected");
        setPlayerId(message.playerId);
        setRoomCode(message.roomCode);
        localStorage.setItem(`starwish.resume.${message.roomCode}`, message.resumeToken);
        retryCountRef.current = 0;
        return;
      }
      if (message.type === "state") {
        setView(message.view);
        setProfile(message.view.self.collection);
        setRoomCode(message.view.roomCode);
        setConnection("connected");
        setBattleSelection(message.view.self.selectedCardIds);
        setTargetId(message.view.self.selectedTargets[0] ?? message.view.enemies[0]?.id ?? "");
        navigate(message.view.phase === "combat" || message.view.phase === "reward" || message.view.phase === "victory" || message.view.phase === "defeat" ? "battle" : "room");
        return;
      }
      if (message.type === "error") pushToast(message.message, "error");
      if (message.type === "notice") pushToast(message.message, "info");
    };
    socket.onerror = () => {
      if (!isRetry) pushToast("連線暫時無法使用，請確認房主已啟動遊戲。", "error");
    };
    socket.onclose = () => {
      if (socket !== socketRef.current || manualCloseRef.current || demoRef.current) return;
      setConnection("offline");
      const nextAttempt = retryCountRef.current + 1;
      retryCountRef.current = nextAttempt;
      const delay = Math.min(15000, 1200 * 2 ** Math.min(nextAttempt - 1, 4));
      retryTimerRef.current = window.setTimeout(() => connectRoom(normalizedCode, true), delay);
    };
  }, [displayName, navigate, pushToast]);

  const createRoom = useCallback(async () => {
    localStorage.setItem("starwish.displayName", displayName.trim() || "星旅人");
    setConnection("connecting");
    try {
      const response = await fetch("/api/rooms", { method: "POST" });
      if (!response.ok) throw new Error(`伺服器回應 ${response.status}`);
      const data = await response.json() as { roomCode: string; addresses?: Array<{ kind: "local" | "hamachi"; ip: string; url: string }> };
      if (!data.roomCode) throw new Error("伺服器沒有回傳房間代碼");
      setAddresses(data.addresses ?? []);
      connectRoom(data.roomCode);
      navigate("room");
    } catch (error) {
      setConnection("offline");
      pushToast(error instanceof Error ? `建立房間失敗：${error.message}` : "建立房間失敗。可改用練習模式。", "error");
    }
  }, [connectRoom, displayName, navigate, pushToast]);

  const joinRoom = useCallback((event: FormEvent) => {
    event.preventDefault();
    localStorage.setItem("starwish.displayName", displayName.trim() || "星旅人");
    setAddresses([]);
    connectRoom(roomCodeInput);
  }, [connectRoom, displayName, roomCodeInput]);

  const playDemo = useCallback(() => {
    const code = `練習-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const oldSocket = socketRef.current;
    socketRef.current = null;
    manualCloseRef.current = true;
    oldSocket?.close();
    manualCloseRef.current = false;
    demoRef.current = true;
    setConnection("demo");
    setPlayerId("solo-player");
    setRoomCode(code);
    setAddresses([]);
    const newState = engine.createRoom(code);
    const joined = engine.join(newState, "solo-player", displayName.trim() || "星旅人", profileRef.current);
    localEngineStateRef.current = joined.state;
    setView(engine.viewFor(joined.state, "solo-player"));
    setBattleSelection([]);
    navigate("room");
    pushToast("練習模式已開啟。戰鬥與星晶獎勵只保存在這台裝置。", "info");
  }, [navigate, pushToast]);

  const leaveRoom = useCallback(() => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    manualCloseRef.current = true;
    const oldSocket = socketRef.current;
    socketRef.current = null;
    oldSocket?.close(1000, "Player left the room");
    manualCloseRef.current = false;
    demoRef.current = false;
    localEngineStateRef.current = null;
    setConnection("offline");
    setView(null);
    setPlayerId("");
    setRoomCode("");
    setAddresses([]);
    setBattleSelection([]);
    setTargetId("");
    navigate("home");
  }, [navigate]);

  const dispatchDemo = useCallback((action: GameAction) => {
    const currentState = localEngineStateRef.current;
    if (!currentState) return;
    const result = engine.dispatch(currentState, "solo-player", action);
    if (result.error) {
      pushToast(result.error.message, "error");
      return;
    }
    localEngineStateRef.current = result.state;
    const nextView = engine.viewFor(result.state, "solo-player");
    setView(nextView);
    setProfile(nextView.self.collection);
    setBattleSelection(nextView.self.selectedCardIds);
    setTargetId(nextView.self.selectedTargets[0] ?? nextView.enemies[0]?.id ?? "");
  }, [pushToast]);

  const sendAction = useCallback((action: GameAction) => {
    if (demoRef.current) {
      dispatchDemo(action);
      return;
    }
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      pushToast("目前沒有連線中的房間。", "error");
      return;
    }
    socketRef.current.send(JSON.stringify(action));
  }, [dispatchDemo, pushToast]);

  const performSummon = useCallback(() => {
    if (summonLockedRef.current) return;
    if (!canSummonNow) {
      pushToast("請先離開進行中的房間，再召喚角色或卡牌。", "info");
      return;
    }
    const result = drawFromPool(profileRef.current, pool);
    if (result.error) {
      pushToast(result.error.message, "error");
      return;
    }
    const drop = result.drop;
    if (!drop) return;
    summonLockedRef.current = true;
    setLocalProfile(result.profile);
    setSummonRarity(drop.rarity);
    setRevealing(true);
    setLastDrop(null);
    const revealDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1350;
    summonTimerRef.current = window.setTimeout(() => {
      setLastDrop(drop);
      setRevealing(false);
      summonLockedRef.current = false;
      summonTimerRef.current = null;
      pushToast(drop.refunded ? `已抽到滿級重複項目，退還 ${drop.refunded} 星晶。` : drop.upgraded ? `${drop.name} 升至 ${levelText(drop.level)}。` : `新收藏已加入：${drop.name}。`, "success");
    }, revealDelay);
  }, [canSummonNow, pool, pushToast, setLocalProfile]);

  const exportProfile = useCallback(() => {
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "starwish-profile.json";
    link.click();
    URL.revokeObjectURL(link.href);
    pushToast("收藏檔已匯出。", "success");
  }, [profile, pushToast]);

  const importProfile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (connection !== "offline" || view !== null) {
      const message = "請先離開房間，再匯入收藏檔以免進度不同步。";
      setImportError(message);
      pushToast(message, "error");
      event.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(String(reader.result)) as unknown;
        const migrated = migratePlayerProfile(imported);
        const safe: PlayerProfile = {
          ...migrated,
          selectedDeckCardIds: migrated.selectedDeckCardIds.length ? migrated.selectedDeckCardIds : [...initialDeckIds],
        };
        setLocalProfile(safe);
        setImportError("");
        pushToast("收藏檔已匯入。", "success");
      } catch (error) {
        const message = error instanceof Error ? error.message : "無法讀取這個收藏檔。";
        setImportError(message);
        pushToast(message, "error");
      } finally {
        event.target.value = "";
      }
    };
    reader.readAsText(file);
  }, [connection, pushToast, setLocalProfile, view]);

  const toggleDeckCard = useCallback((cardId: string) => {
    const currentDeck = profileRef.current.selectedDeckCardIds.length ? profileRef.current.selectedDeckCardIds : [...initialDeckIds];
    if (currentDeck.includes(cardId)) {
      if (currentDeck.length <= 8) {
        pushToast("牌組需要保留 8 張卡牌。", "info");
        return;
      }
      const nextDeck = currentDeck.filter((id) => id !== cardId);
      sendAction({ type: "set-deck", cardIds: nextDeck });
      setLocalProfile({ ...profileRef.current, selectedDeckCardIds: nextDeck });
      return;
    }
    if (currentDeck.length >= 8) {
      const replaceable = currentDeck.find((id) => !initialDeckIds.includes(id));
      if (!replaceable) {
        pushToast("牌組最多替換 4 張基礎牌，請先抽取更多卡牌。", "info");
        return;
      }
      const nextDeck = [...currentDeck.filter((id) => id !== replaceable), cardId];
      sendAction({ type: "set-deck", cardIds: nextDeck });
      setLocalProfile({ ...profileRef.current, selectedDeckCardIds: nextDeck });
      pushToast(`${cards.find((card) => card.id === cardId)?.name} 已替換 ${cards.find((card) => card.id === replaceable)?.name}。`, "success");
      return;
    }
    const nextDeck = [...currentDeck, cardId];
    sendAction({ type: "set-deck", cardIds: nextDeck });
    setLocalProfile({ ...profileRef.current, selectedDeckCardIds: nextDeck });
  }, [pushToast, sendAction, setLocalProfile]);

  const copyAddress = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast("加入網址已複製。", "success");
    } catch {
      pushToast(value, "info");
    }
  }, [pushToast]);

  const activeView = view;
  const isNetworkRoom = connection === "connected";
  const canStart = activeView?.phase === "lobby" && (!isNetworkRoom || activeView.hostPlayerId === playerId);

  const drawCardIds = pool === "character" ? characterPoolIds : cardPoolIds;
  const makePlanTargets = (ids: string[]): string[] => ids.map((id) => {
    const targetKind = cards.find((card) => card.id === id)?.target;
    if (targetKind === "all-enemies") return "all-enemies";
    if (targetKind === "self") return playerId || "self";
    if (targetKind === "ally") return playerId || activeView?.players[0]?.id || "self";
    return targetId || activeView?.enemies[0]?.id || "";
  });

  return (
    <div className="app-shell">
      <aside className="side-rail" aria-label="主要導覽">
        <button className="brand-mark" type="button" onClick={() => (view || connection === "demo" || connection === "connected") ? leaveRoom() : navigate("home")} aria-label="回到遠征大廳"><span>星</span><i>✦</i></button>
        <div className="side-rail__line" />
        <nav className="side-nav">
          {(["home", "summon", "collection"] as Route[]).map((item) => (
            <button key={item} className={`side-nav__item ${route === item ? "is-active" : ""}`} onClick={() => item === "home" && (view || connection === "demo" || connection === "connected") ? leaveRoom() : navigate(item)} type="button" aria-current={route === item ? "page" : undefined}>
              <span className="side-nav__icon" aria-hidden="true">{item === "home" ? "⌂" : item === "summon" ? "✧" : "▤"}</span>
              <span>{routeNames[item]}</span>
            </button>
          ))}
        </nav>
        <div className="side-rail__bottom"><span className={`connection-dot connection-dot--${connection}`} /><span>{connection === "demo" ? "練習模式" : connection === "connected" ? "隊伍已連線" : connection === "connecting" ? "正在連線" : "尚未連線"}</span></div>
      </aside>

      <main className="main-stage">
        <header className="top-bar">
          <div className="top-bar__crumb"><span>星象台</span><b aria-hidden="true">/</b><strong>{routeNames[route]}</strong></div>
          <div className="top-bar__actions">
            <div className="currency-chip" aria-label={`持有 ${displayCurrency} 星晶`}><span className="currency-chip__star">✦</span><span>{displayCurrency.toLocaleString()}</span><small>星晶</small></div>
            <button className="profile-chip" type="button" onClick={() => navigate("collection")} aria-label="開啟收藏檔案"><span className="profile-chip__avatar">{selectedCharacter.name.slice(0, 1)}</span><span>{displayName || "星旅人"}</span><i aria-hidden="true">⌄</i></button>
          </div>
        </header>

        {route === "home" && (
          <section className="hub-page page-enter" aria-labelledby="hub-title">
            <div className="hero-banner">
              <div className="hero-banner__image" aria-hidden="true" />
              <div className="hero-banner__shade" aria-hidden="true" />
              <div className="hero-banner__content">
                <p className="hero-banner__eyebrow"><span className="tiny-star">✦</span> 月台星象 · 遠征準備中</p>
                <h1 id="hub-title">星願魔法團</h1>
                <p className="hero-banner__subtitle">把願望寫進星圖，和夥伴一起迎向夜色。</p>
                <div className="hero-banner__actions">
                  <button className="button button--gold" type="button" onClick={() => playDemo()}><span>開始單人遠征</span><b aria-hidden="true">✦</b></button>
                  <button className="button button--glass" type="button" onClick={() => createRoom()}>建立合作房間</button>
                </div>
              </div>
              <div className="hero-banner__signature"><span>STARFALL EXPEDITION</span><i>01 — 04</i></div>
            </div>

            <div className="hub-lower">
              <section className="panel expedition-panel" aria-labelledby="expedition-title">
                <div className="section-heading">
                  <div><span className="section-heading__mark">✧</span><h2 id="expedition-title">遠征航線</h2></div>
                  <span className="quiet-label">一局約 15–25 分鐘</span>
                </div>
                <div className="expedition-map">
                  <div className="map-line" aria-hidden="true" />
                  {["月台", "星砂林", "玻璃庭", "蝕月之門"].map((name, index) => <div className={`map-stop ${index === 0 ? "is-current" : ""}`} key={name}><span className="map-stop__orb">{index === 3 ? "☾" : "✦"}</span><small>{name}</small></div>)}
                </div>
                <div className="expedition-panel__footer"><span><b>4</b> 場戰鬥</span><span><b>3</b> 張沿途獎勵</span><span><b>∞</b> 星夜相伴</span></div>
              </section>

              <section className="panel join-panel" aria-labelledby="join-title">
                <div className="section-heading">
                  <div><span className="section-heading__mark">⌁</span><h2 id="join-title">召集隊友</h2></div>
                  <span className="quiet-label">最多 4 位魔法少女</span>
                </div>
                <form className="join-form" onSubmit={joinRoom}>
                  <label htmlFor="display-name">你的稱呼</label>
                  <input id="display-name" value={displayName} maxLength={18} onChange={(event) => setDisplayName(event.target.value)} onBlur={() => localStorage.setItem("starwish.displayName", displayName.trim() || "星旅人")} placeholder="輸入稱呼" />
                  <label htmlFor="room-code">房間代碼</label>
                  <div className="join-form__code-row"><input id="room-code" value={roomCodeInput} maxLength={12} onChange={(event) => setRoomCodeInput(event.target.value.toUpperCase())} placeholder="例如：LUNA42" /><button className="button button--small" type="submit">加入</button></div>
                </form>
                <div className="join-panel__foot"><span className="connection-dot connection-dot--soft" />同一 Wi-Fi 或 Hamachi 都能加入</div>
              </section>
            </div>

            <div className="hub-strip">
              <div className="hub-strip__party"><div className="mini-portraits">{characters.slice(0, 4).map((character) => <CharacterPortrait key={character.id} characterId={character.id} size="small" />)}</div><div><strong>你的星光小隊</strong><small>{ownedCharacterIds.length} 位夥伴 · {profile.selectedDeckCardIds.length || 8} 張牌</small></div><button type="button" className="text-button" onClick={() => navigate("collection")}>整備牌組 <span aria-hidden="true">↗</span></button></div>
              <button className="summon-teaser" type="button" onClick={() => navigate("summon")}><span className="summon-teaser__ornament">✧</span><span><strong>星願召喚</strong><small>以星晶遇見新夥伴與卡牌</small></span><span className="summon-teaser__price">100 <i>✦</i></span></button>
            </div>
          </section>
        )}

        {route === "room" && (
          <section className="room-page page-enter" aria-labelledby="room-title">
            <div className="page-title-row"><div><p className="eyebrow">隊伍月台</p><h1 id="room-title">整裝待發</h1><p>確認夥伴與牌組，再由房主開啟遠征。</p></div><button type="button" className="button button--subtle" onClick={leaveRoom}>離開房間</button></div>
            <div className="room-grid">
              <section className="panel room-panel room-panel--team">
                <div className="section-heading"><div><span className="section-heading__mark">✦</span><h2>遠征隊伍</h2></div><span className="pill">{activeView?.players.length ?? 0} / 4</span></div>
                <div className="member-list">
                  {activeView?.players.map((player, index) => {
                    const character = characters.find((item) => item.id === player.characterId);
                    return <div className="member-row" key={player.id}><div className="member-row__number">0{index + 1}</div>{character ? <CharacterPortrait characterId={character.id} size="small" /> : <div className="member-empty">✧</div>}<div className="member-row__copy"><strong>{player.displayName}{player.id === activeView.hostPlayerId && <span className="host-tag">房主</span>}</strong><small>{character?.title ?? "選擇一位魔法少女"}</small></div><span className={`member-state ${player.connected ? "is-online" : ""}`}>{player.connected ? "已連線" : "離線"}</span></div>;
                  })}
                  {Array.from({ length: Math.max(0, 4 - (activeView?.players.length ?? 0)) }).map((_, index) => <div className="member-row member-row--empty" key={`empty-${index}`}><div className="member-row__number">0{(activeView?.players.length ?? 0) + index + 1}</div><div className="member-empty">＋</div><div className="member-row__copy"><strong>等待隊友加入</strong><small>把加入網址分享給朋友</small></div><span className="member-state">空位</span></div>)}
                </div>
                <div className="room-share">
                  <div><strong>房間代碼</strong><small>分享這組代碼，讓隊友加入。</small></div>
                  <button type="button" className="room-code-button" onClick={() => copyAddress(roomCode)}>{roomCode || "準備房間中"}<span aria-hidden="true">▢</span></button>
                </div>
                {addresses.length > 0 && <div className="address-list">{addresses.map((address) => <div className="address-row" key={`${address.kind}-${address.url}`}><div><strong>{address.kind === "hamachi" ? "Hamachi" : "同一 Wi-Fi"}</strong><small>{address.ip}</small></div><button type="button" className="text-button" onClick={() => copyAddress(address.url)}>複製加入網址</button></div>)}</div>}
                {connection === "demo" && <div className="demo-banner"><span>✧</span> 練習模式：只在此裝置模擬房間與戰鬥。</div>}
              </section>

              <section className="panel room-panel room-panel--build">
                <div className="section-heading"><div><span className="section-heading__mark">◈</span><h2>選擇魔法少女</h2></div><button type="button" className="text-button" onClick={() => navigate("collection")}>管理收藏</button></div>
                <div className="character-picker">
                  {characters.filter((character) => ownedCharacterIds.includes(character.id)).map((character) => <button type="button" key={character.id} className={`character-option ${profile.selectedCharacterId === character.id ? "is-selected" : ""}`} onClick={() => { setLocalProfile({ ...profileRef.current, selectedCharacterId: character.id }); sendAction({ type: "select-character", characterId: character.id }); }} aria-pressed={profile.selectedCharacterId === character.id}><CharacterPortrait characterId={character.id} size="normal" /><span className="character-option__copy"><strong>{character.name}</strong><small>{character.title}</small><em>{levelText(profile.ownedCharacterLevels[character.id] ?? 1)} · {character.element}屬性</em></span><i className="character-option__check" aria-hidden="true">✓</i></button>)}
                </div>
                <div className="deck-summary"><div><strong>遠征牌組</strong><small>8 張卡 · 最多替換 4 張基礎牌</small></div><button type="button" className="text-button" onClick={() => navigate("collection")}>調整牌組</button></div>
                <div className="deck-pill-row">{(profile.selectedDeckCardIds.length ? profile.selectedDeckCardIds : initialDeckIds).slice(0, 8).map((id) => <span key={id} className="deck-pill">{cards.find((card) => card.id === id)?.name ?? id}</span>)}</div>
                {canStart ? <button type="button" className="button button--gold button--wide" onClick={() => { sendAction({ type: "set-deck", cardIds: profile.selectedDeckCardIds.length ? profile.selectedDeckCardIds : initialDeckIds }); sendAction({ type: "start-run" }); navigate("battle"); }}>開始遠征 <span>✦</span></button> : <div className="waiting-host"><span className="connection-dot connection-dot--soft" />{connection === "connected" ? "等待房主開始遠征" : "尚未連線到房間"}</div>}
              </section>
            </div>
          </section>
        )}

        {route === "battle" && (
          <section className="battle-page page-enter" aria-labelledby="battle-title">
            <div className="battle-topline"><button type="button" className="back-link" onClick={() => navigate("room")}>‹ 隊伍月台</button><span>第 {Math.min((activeView?.encounterIndex ?? 0) + 1, 4)} / 4 場戰鬥</span><span>回合 {activeView?.round ?? 1}</span></div>
            {!activeView ? <div className="empty-state panel"><span>✧</span><h1>尚未開始遠征</h1><p>先建立或加入一個房間。</p><button className="button button--gold" onClick={() => navigate("home")} type="button">前往遠征大廳</button></div> : activeView.phase === "reward" ? (
              <div className="reward-screen"><div className="reward-copy"><p className="eyebrow">沿途發現</p><h1 id="battle-title">挑一張卡，<br />把星光帶上路。</h1><p>這張卡只加入本次遠征牌組。每位隊員都能各自選擇。</p><span className="reward-coin">✦ 通過戰鬥獲得 30 星晶</span></div><div className="reward-cards">{activeView.rewardOptions.map((card) => <GameCard key={card.id} card={card} label="加入本次遠征" onClick={() => sendAction({ type: "choose-reward", cardId: card.id })} />)}</div></div>
            ) : activeView.phase === "victory" || activeView.phase === "defeat" ? (
              <div className={`result-screen result-screen--${activeView.phase}`}><div className="result-screen__art"><CharacterPortrait characterId={profile.selectedCharacterId} size="large" /></div><div className="result-screen__copy"><p className="eyebrow">{activeView.phase === "victory" ? "星路已照亮" : "暫時撤退"}</p><h1 id="battle-title">{activeView.phase === "victory" ? "願望抵達了。" : "下一次，我們會更靠近。"}</h1><p>{activeView.phase === "victory" ? "蝕月退去，新的星光正等著你。" : "星晶和收藏仍留在你的檔案裡，再整裝一次吧。"}</p><button type="button" className="button button--gold" onClick={leaveRoom}>回到遠征大廳</button></div></div>
            ) : (
              <>
                <div className="battle-arena">
                  <div className="battle-arena__sky" aria-hidden="true" />
                  <div className="battle-arena__heading"><div><p className="eyebrow">星夜遭遇</p><h1 id="battle-title">{activeView.enemies[0]?.name ?? "微光閃動"}</h1></div><span className="round-chip">回合 {activeView.round}</span></div>
                  <div className="enemy-row">{activeView.enemies.map((enemy) => <button type="button" key={enemy.id} className={`enemy-card ${targetId === enemy.id ? "is-targeted" : ""}`} onClick={() => setTargetId(enemy.id)} aria-pressed={targetId === enemy.id}><div className="enemy-card__sigil" aria-hidden="true">☾</div><strong>{enemy.name}</strong><div className="health-track"><span style={{ width: `${Math.max(0, enemy.hp / enemy.maxHp * 100)}%` }} /></div><small>{enemy.hp} / {enemy.maxHp} 生命</small><em>意圖：{enemy.intent} {enemy.intentValue}</em></button>)}</div>
                  <div className="party-status">{activeView.players.map((player) => <div className="party-status__member" key={player.id}><CharacterPortrait characterId={player.characterId ?? "luna"} size="small" /><div className="party-status__stats"><strong>{player.displayName}{player.id === playerId ? "（你）" : ""}</strong><div className="health-track health-track--rose"><span style={{ width: `${player.hp / player.maxHp * 100}%` }} /></div><small>生命 {player.hp}/{player.maxHp}　護盾 {player.block}</small></div><div className="energy-pips" aria-label={`能量 ${player.energy} / ${player.maxEnergy}`}>{Array.from({ length: player.maxEnergy }).map((_, i) => <i key={i} className={i < player.energy ? "is-filled" : ""}>✦</i>)}</div></div>)}</div>
                </div>
                <div className="battle-log" aria-label="戰鬥紀錄"><span>✧</span>{activeView.battleLog.slice(-1)[0] ?? "選擇手牌並安排目標。"}</div>
                <div className="hand-heading"><div><h2>你的手牌</h2><span>選好卡牌，再提交計畫。</span></div><span className="energy-chip">能量 <b>{activeView.players.find((item) => item.id === playerId)?.energy ?? activeView.players[0]?.energy ?? 0}</b> / {activeView.players.find((item) => item.id === playerId)?.maxEnergy ?? activeView.players[0]?.maxEnergy ?? 0}</span></div>
                <div className="hand-row">{activeView.self.hand.map((card) => { const isSelected = battleSelection.includes(card.id); const available = battleSelection.reduce((total, selectedId) => total + (activeView.self.hand.find((item) => item.id === selectedId)?.cost ?? 0), 0) - (isSelected ? card.cost : 0); const player = activeView.players.find((item) => item.id === playerId) ?? activeView.players[0]; return <GameCard key={card.id} card={card} selected={isSelected} disabled={!isSelected && Boolean(player && available + card.cost > player.energy)} onClick={() => setBattleSelection((selected) => selected.includes(card.id) ? selected.filter((id) => id !== card.id) : [...selected, card.id])} />; })}</div>
                <div className="battle-actions"><span>已選 {battleSelection.length} 張卡</span><button type="button" className="button button--subtle" onClick={() => { sendAction({ type: "submit-plan", cardIds: battleSelection, targets: makePlanTargets(battleSelection) }); }}>提交計畫</button><button type="button" className="button button--gold" onClick={() => { sendAction({ type: "submit-plan", cardIds: battleSelection, targets: makePlanTargets(battleSelection) }); sendAction({ type: "ready" }); }}>準備結算 <span>✦</span></button></div>
              </>
            )}
          </section>
        )}

        {route === "summon" && (
          <section className="summon-page page-enter" aria-labelledby="summon-title">
            <div className="summon-heading"><div><p className="eyebrow">星辰的回信</p><h1 id="summon-title">星願召喚</h1><p>把星晶放進月光裡，看看誰會回應你的願望。</p></div><div className="summon-balance"><span>✦</span><strong>{profile.currency.toLocaleString()}</strong><small>可用星晶</small></div></div>
            <div className="summon-layout">
              <div className={`summon-art ${revealing ? `is-revealing summon-art--${summonRarity}` : ""} ${lastDrop ? `summon-art--${lastDrop.rarity}` : ""}`} aria-label="四位原創魔法少女在星空下等待召喚"><div className="summon-art__image" /><div className="summon-art__glow" />{revealing && <div className="summon-ritual" aria-hidden="true"><div className="summon-ritual__rays" /><div className="summon-ritual__ring summon-ritual__ring--outer" /><div className="summon-ritual__ring summon-ritual__ring--inner" /><div className="summon-ritual__crest">✧</div>{Array.from({ length: 12 }, (_, index) => <i key={index} className="summon-ritual__spark" style={{ "--angle": `${index * 30}deg`, "--index": index } as CSSProperties}>✦</i>)}</div>}{lastDrop ? <div className="summon-art__reveal" key={`${lastDrop.pool}-${lastDrop.id}-${lastDrop.level}`}><span className="summon-art__reveal-mark" aria-hidden="true">{lastDrop.pool === "character" ? "✧" : "◈"}</span><small>{rarityName(lastDrop.rarity)} · {lastDrop.pool === "character" ? "角色" : "卡牌"}</small><strong>{lastDrop.name}</strong><span>{lastDrop.refunded ? "星晶回響" : lastDrop.upgraded ? "星光更耀眼了" : "願望已經抵達"}</span></div> : <div className="summon-art__copy"><span className="tiny-star">✦</span><strong>星光會記得<br />每一個願望。</strong><small>STAR WISHES FIND THEIR WAY</small></div>}<div className="summon-art__sigil">✧</div></div>
              <div className="summon-console panel">
                <div className="pool-tabs" role="tablist" aria-label="召喚池"><button type="button" role="tab" aria-selected={pool === "character"} className={pool === "character" ? "is-active" : ""} disabled={revealing} onClick={() => { setPool("character"); setLastDrop(null); }}>角色召喚</button><button type="button" role="tab" aria-selected={pool === "card"} className={pool === "card" ? "is-active" : ""} disabled={revealing} onClick={() => { setPool("card"); setLastDrop(null); }}>卡牌召喚</button></div>
                <div className="pool-summary"><span className="pool-summary__ornament">{pool === "character" ? "✧" : "◈"}</span><div><h2>{pool === "character" ? "星之同伴" : "旅途秘術"}</h2><p>{pool === "character" ? "讓新夥伴加入你的收藏與下一趟遠征。" : "把新的魔法帶進你編排的牌組。"}</p></div></div>
                <div className="rates-box"><div><strong>召喚機率</strong><small>每次抽取獨立計算 · 沒有保底</small></div><div className="rate-list"><span><i className="rarity-dot rarity-dot--common" />普通 <b>{Math.round(RARITY_ODDS.common * 100)}%</b></span><span><i className="rarity-dot rarity-dot--rare" />稀有 <b>{Math.round(RARITY_ODDS.rare * 100)}%</b></span><span><i className="rarity-dot rarity-dot--epic" />史詩 <b>{Math.round(RARITY_ODDS.epic * 100)}%</b></span></div></div>
                {lastDrop && <div className={`summon-result summon-result--${lastDrop.rarity}`} role="status"><span className="summon-result__star">✦</span><div><small>{lastDrop.refunded ? "滿級重複收藏" : lastDrop.upgraded ? "收藏升級" : "新收藏"} · {rarityName(lastDrop.rarity)}</small><strong>{lastDrop.name}</strong><span>{lastDrop.refunded ? `退還 ${lastDrop.refunded} 星晶` : `${levelText(lastDrop.level)}${lastDrop.upgraded ? " · 能力提升" : " · 已加入收藏"}`}</span></div><span className="summon-result__sparkle" aria-hidden="true">✧</span></div>}
                <button type="button" className={`button button--gold button--wide summon-button ${revealing ? "is-loading" : ""}`} onClick={() => performSummon()} disabled={revealing || !canSummonNow || profile.currency < GACHA_COST}><span>{revealing ? "星光正在聚集…" : `召喚一次　${GACHA_COST} 星晶`}</span><i aria-hidden="true">✧</i></button>
                {!canSummonNow ? <small className="insufficient-hint">離開進行中的房間後，即可召喚並保存收藏。</small> : profile.currency < GACHA_COST && <small className="insufficient-hint">星晶不足。完成一般戰可獲得 30 星晶，擊敗頭目可獲得 60 星晶。</small>}
                <div className="pool-preview"><span>池內收藏</span><div>{drawCardIds.map((id) => { const definition = pool === "character" ? characters.find((item) => item.id === id) : cards.find((item) => item.id === id); const rarity = definition?.rarity ?? "common"; return <i key={id} className={`pool-preview__gem rarity-${rarity}`} title={definition?.name ?? id}>✦</i>; })}</div></div>
              </div>
            </div>
            <p className="summon-note">重複獲得未滿三級的收藏會提升至下一級；滿三級後再次獲得，退還 25 星晶。</p>
          </section>
        )}

        {route === "collection" && (
          <section className="collection-page page-enter" aria-labelledby="collection-title">
            <div className="page-title-row"><div><p className="eyebrow">你的魔法筆記</p><h1 id="collection-title">收藏檔案</h1><p>選擇遠征角色，從收藏中替換最多四張基礎牌。</p></div><div className="collection-actions"><button type="button" className="button button--subtle" onClick={() => exportProfile()}>匯出 JSON</button><label className="button button--subtle file-button">匯入 JSON<input type="file" accept="application/json,.json" onChange={importProfile} /></label></div></div>
            {importError && <div className="inline-error" role="alert">{importError}</div>}
            <div className="collection-stats"><div><span>星晶</span><strong>✦ {profile.currency}</strong></div><div><span>完成遠征</span><strong>{profile.completedRuns}</strong></div><div><span>通過戰鬥</span><strong>{profile.clearedEncounters}</strong></div><div><span>卡牌收藏</span><strong>{ownedCardIds.length} / {cards.length}</strong></div></div>
            <div className="collection-section-heading"><div><p className="eyebrow">夥伴名錄</p><h2>魔法少女</h2></div><span>{ownedCharacterIds.length} 位加入收藏</span></div>
            <div className="character-grid">{characters.map((character) => { const level = profile.ownedCharacterLevels[character.id] ?? 0; const owned = level > 0; return <button type="button" key={character.id} className={`character-card ${owned ? "" : "is-locked"} ${profile.selectedCharacterId === character.id ? "is-favorite" : ""}`} onClick={() => owned && (setLocalProfile({ ...profileRef.current, selectedCharacterId: character.id }), sendAction({ type: "select-character", characterId: character.id }))} disabled={!owned}><CharacterPortrait characterId={character.id} size="large" /><div className="character-card__copy"><span className={`rarity-text rarity-text--${character.rarity}`}>{rarityName(character.rarity)} · {character.element}屬性</span><h3>{character.name}</h3><strong>{character.title}</strong><p>{character.summary}</p><span>{owned ? `${levelText(level)}${profile.selectedCharacterId === character.id ? " · 遠征中" : ""}` : "尚未召喚"}</span></div>{!owned && <span className="locked-mark">✦</span>}</button>; })}</div>
            <div className="collection-section-heading collection-section-heading--deck"><div><p className="eyebrow">旅途編排</p><h2>我的牌組 <small>{profile.selectedDeckCardIds.length || 8} / 8</small></h2></div><span>最多替換 {Math.min(4, Math.max(0, ownedCardIds.length - 8))} 張收藏卡</span></div>
            <div className="deck-editor"><div className="deck-editor__active"><div className="deck-editor__subhead"><strong>遠征牌組</strong><small>點選下方收藏卡加入；滿 8 張時會替換一張加入的卡牌。</small></div><div className="deck-editor__cards">{(profile.selectedDeckCardIds.length ? profile.selectedDeckCardIds : initialDeckIds).map((id) => { const card = cardView(id, profile); return card ? <GameCard key={id} card={card} compact label="已編入" onClick={() => toggleDeckCard(id)} /> : null; })}</div></div><div className="deck-editor__collection"><div className="deck-editor__subhead"><strong>可編入的收藏卡</strong><small>{ownedCardIds.length} 張已收藏</small></div><div className="collection-cards">{ownedCardIds.map((id) => { const card = cardView(id, profile); if (!card) return null; const inDeck = (profile.selectedDeckCardIds.length ? profile.selectedDeckCardIds : initialDeckIds).includes(id); return <GameCard key={id} card={card} compact selected={inDeck} label={inDeck ? "已編入" : "點擊編入"} onClick={() => toggleDeckCard(id)} />; })}</div></div></div>
            <div className="collection-footnote"><span>✦</span><p>收藏存在這個瀏覽器中。匯出 JSON 可備份或搬到另一台裝置；多人房間會在加入時收到你的收藏。</p><button type="button" className="text-button" onClick={() => navigate("summon")}>前往召喚 <span>↗</span></button></div>
          </section>
        )}

        <footer className="site-footer"><span>星願魔法團</span><span>月光仍亮著，旅程就還沒結束。</span><a href="https://github.com/yuiban76/starwish-magical-team" target="_blank" rel="noreferrer">GitHub 原始碼 <span aria-hidden="true">↗</span></a></footer>
      </main>

      <nav className="mobile-nav" aria-label="主要導覽">{(["home", "summon", "collection"] as Route[]).map((item) => <button type="button" key={item} className={route === item ? "is-active" : ""} onClick={() => item === "home" && (view || connection === "demo" || connection === "connected") ? leaveRoom() : navigate(item)} aria-current={route === item ? "page" : undefined}><span aria-hidden="true">{item === "home" ? "⌂" : item === "summon" ? "✧" : "▤"}</span><small>{routeNames[item]}</small></button>)}</nav>
      {toast && <div className={`toast toast--${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}><span>{toast.kind === "error" ? "!" : "✦"}</span>{toast.message}<button type="button" aria-label="關閉訊息" onClick={() => setToast(null)}>×</button></div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
