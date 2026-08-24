import "dotenv/config";

const token = process.env.TELEGRAM_BOT_TOKEN || "";
const chatId = process.env.TELEGRAM_CHAT_ID || "";
if (!token || !chatId) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    chat_id: chatId,
    text: "🔴🔴🔴 强提醒测试 🔴🔴🔴\n\n✅ Robinhood Chain 发射台监控已接入\n\n发射台: pons\n官网: https://ponsfamily.com\nX/Twitter: https://x.com/ponsdotfamily\n模式: Uniswap V3 pool-native; same-pool graduation\n匹配: exact_factory\n\n实际推送会为未知候选标记社交账号待确认。",
    disable_web_page_preview: true,
    disable_notification: false,
    reply_markup: {
      inline_keyboard: [[
        { text: "📈 一键打开 GMGN", url: "https://gmgn.ai/robinhood/token/0x39dBED3a2bd333467115dE45665cC57F813C4571" },
        { text: "🔍 查看合约", url: "https://robinhoodchain.blockscout.com/address/0x39dBED3a2bd333467115dE45665cC57F813C4571" },
      ]],
    },
  }),
  signal: AbortSignal.timeout(10_000),
});
const payload = await response.json();
if (!response.ok || !payload.ok) {
  console.error(`Telegram test failed: ${payload.description || response.status}`);
  process.exit(1);
}
console.log(`Telegram test delivered to chat ${payload.result.chat.id}`);
