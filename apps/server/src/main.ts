import { engine } from "@starwish/shared";
import { startGameServer } from "./server.js";

const portValue = Number.parseInt(process.env.PORT ?? "3000", 10);
const port = Number.isInteger(portValue) && portValue >= 0 && portValue <= 65_535 ? portValue : 3000;
const host = process.env.HOST ?? "0.0.0.0";

const running = await startGameServer({ engine, host, port });
console.info(`星願魔法團主機已啟動：http://${running.address.host}:${running.address.port}`);
console.info("房間加入網址會列在房間建立畫面；請將對應的區域網路或 Hamachi 網址分享給玩家。");

const shutdown = async () => {
  await running.close();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
