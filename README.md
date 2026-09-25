# 星願魔法團

繁體中文魔法少女合作牌組遊戲。單人也能闖關；也可以和 2–4 位朋友一起打三場遭遇戰與頭目戰。收集角色、抽取卡牌，打造自己的戰鬥牌組。

GitHub 保存原始碼。遊戲伺服器由房主自己的電腦執行，朋友可透過 Hamachi 虛擬 IP 或同一 Wi-Fi 加入。

## 快速開始

需要 Node.js 20 或更新版本，以及 pnpm。

```powershell
pnpm install
pnpm build
pnpm start
```

房主在瀏覽器開啟 `http://localhost:3000`，建立房間後把畫面顯示的加入網址和房間代碼分享給朋友。

- 同一 Wi-Fi 的朋友使用「區域網路」網址。
- 外地電腦玩家先加入房主的 Hamachi 網路，再使用「Hamachi」網址。
- 手機可在與房主同一 Wi-Fi 時使用區域網路網址。

若朋友無法連線，請確認房主電腦的防火牆允許私人網路的 TCP 連接埠 3000，並確認 Hamachi 顯示玩家在線。

## 開發模式

```powershell
pnpm dev
```

健康檢查：`http://localhost:3000/api/health`。

## 存檔與抽卡

- 角色與卡牌收藏、星晶、牌組及單人進度保存在目前瀏覽器的本機儲存空間。遊戲提供 JSON 匯出與匯入，可手動備份或搬移收藏。
- 房間進度保存在房主專案目錄下的 `data/`，重新啟動房主程式時可恢復。
- 抽卡分成角色池與卡牌池，各有普通、稀有、史詩三種稀有度，機率為 60%／30%／10%。單抽 100 星晶，沒有保底；重複內容可升級至三級。
- 收藏檔由玩家自行保管。多人房間用它組成當局牌組，因此本遊戲適合和朋友休閒遊玩，不提供帳號同步或防止存檔修改的服務。

## 專案結構

- `packages/shared`：卡牌與角色資料、戰鬥規則、抽卡與存檔格式、網路訊息型別
- `apps/web`：桌機及手機瀏覽器介面與原創美術
- `apps/server`：房間管理、WebSocket 同步、房主端存檔及靜態檔案服務

## 關於 GitHub Pages

GitHub Pages 只提供靜態網站；它無法執行這款遊戲所需的房間伺服器。朋友需要從 GitHub 取得程式碼，並由房主電腦啟動遊戲服務。[GitHub Pages 說明](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
