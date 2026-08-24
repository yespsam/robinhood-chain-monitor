import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const projectDir = path.resolve(import.meta.dirname, "..");
const envFile = path.join(projectDir, ".env");
const expectedBotId = "7305152923";
const expectedUsername = "SAMPUMPBOT";

function fail(message) {
  console.error(message);
  process.exit(1);
}

let token = "";
try {
  token = execFileSync("pbpaste", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  fail("无法读取剪贴板；请先在 BotFather 中复制新 Token。 ");
}

if (!/^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
  fail("剪贴板内容不是有效的 Telegram Bot Token；配置未修改。 ");
}

let bot;
try {
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true) fail("新 Token 未通过 Telegram 验证；配置未修改。 ");
  bot = payload.result;
} catch {
  fail("暂时无法向 Telegram 验证新 Token；配置未修改。 ");
}

if (String(bot.id) !== expectedBotId || String(bot.username || "").toUpperCase() !== expectedUsername) {
  fail("剪贴板 Token 不属于当前 sambot；配置未修改。 ");
}

const original = fs.readFileSync(envFile, "utf8");
const matches = original.match(/^TELEGRAM_BOT_TOKEN=.*$/gm) || [];
if (matches.length !== 1) fail(".env 中 TELEGRAM_BOT_TOKEN 配置数量异常；配置未修改。 ");

const updated = original.replace(/^TELEGRAM_BOT_TOKEN=.*$/m, `TELEGRAM_BOT_TOKEN=${token}`);
const stat = fs.statSync(envFile);
const tempFile = path.join(projectDir, `.env.telegram-token.${process.pid}.${Date.now()}.tmp`);
try {
  fs.writeFileSync(tempFile, updated, { mode: stat.mode & 0o777 });
  fs.renameSync(tempFile, envFile);
  fs.chmodSync(envFile, stat.mode & 0o777);
} finally {
  if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  token = "";
  spawnSync("pbcopy", { input: "", encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] });
}

console.log(`Telegram Token 已安全更新并验证：@${bot.username} (${bot.id})；剪贴板已清空。`);
