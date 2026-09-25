# 星願魔法團

繁體中文合作卡牌遊戲。房主在自己的電腦啟動遊戲，朋友透過 Hamachi 虛擬 IP 或同一 Wi-Fi 加入。GitHub 保存程式碼；多人遊戲服務由房主電腦執行。

## 專案狀態

目前正在開發。安裝與開房步驟會在可玩版本整合後補齊。

## 技術架構

- `packages/shared`：遊戲規則、遊戲資料、存檔與 WebSocket 契約
- `apps/web`：桌面與手機瀏覽器介面
- `apps/server`：房間管理、即時同步與房主存檔

## 開發

需要 Node.js 20 或更新版本與 pnpm。執行 `pnpm install`、`pnpm dev`。
