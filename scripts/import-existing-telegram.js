import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const source = process.env.TELEGRAM_CONFIG_SOURCE || "/Users/qohfq/Documents/Playground/yesp-quant-execution/config.js";
const existing = require(source);
const token = String(existing?.telegram?.botToken || "").trim();
const chatId = String(existing?.telegram?.chatId || "").trim();
if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(chatId)) {
  throw new Error("Existing Telegram configuration is missing or invalid");
}

const envFile = path.resolve(".env");
let content = "";
try {
  content = await fs.readFile(envFile, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const values = new Map(
  content.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, null] : [line.slice(0, separator), line.slice(separator + 1)];
  }),
);
values.set("TELEGRAM_BOT_TOKEN", token);
values.set("TELEGRAM_CHAT_ID", chatId);
const rendered = [...values].map(([key, value]) => (value === null ? key : `${key}=${value}`)).join("\n");
await fs.writeFile(envFile, `${rendered}\n`, { mode: 0o600 });
await fs.chmod(envFile, 0o600);
console.log("Imported existing Telegram configuration into .env with mode 0600");
