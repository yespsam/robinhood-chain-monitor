const $ = (id) => document.getElementById(id);
const candidates = $("candidates");
let approval = null;

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "本地接口暂不可用");
  return body;
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.reason || result.error || "请求被拒绝");
  return result;
}

function showStatus(status) {
  const card = document.querySelector(".status-card");
  card.classList.toggle("ready", status.ready === true);
  card.classList.toggle("blocked", status.ready !== true);
  $("status-title").textContent = status.ready ? "实盘确认入口已就绪" : "实盘确认入口被门控";
  $("status-detail").textContent = status.reason || "状态未知";
}

async function refresh() {
  $("list-detail").textContent = "正在加载候选…";
  try {
    const [status, data] = await Promise.all([getJson("/api/live-approval/status"), getJson("/api/live-approval/candidates")]);
    showStatus(status);
    candidates.replaceChildren();
    for (const item of data.candidates || []) {
      const card = document.createElement("article"); card.className = "candidate";
      const title = document.createElement("strong"); title.textContent = `${item.symbol || "未知代币"} · ${item.strategy || "策略"}`;
      const detail = document.createElement("p"); detail.textContent = `${item.chain.toUpperCase()} · ${item.address} · 计划 ${item.amountUsd ?? "?"} USD · 分数 ${item.score ?? "?"}`;
      const reason = document.createElement("p"); reason.textContent = (item.reasons || []).join(" / ") || "策略候选；提交前仍需完整门控";
      const button = document.createElement("button"); button.type = "button"; button.textContent = "检查并预览";
      button.disabled = !status.ready;
      button.addEventListener("click", () => prepare(item.id, button));
      card.append(title, detail, reason, button); candidates.append(card);
    }
    $("list-detail").textContent = data.candidates?.length ? `共 ${data.candidates.length} 个候选。页面只展示策略信号，不会自动提交。` : "当前没有合格候选；未买入不等同于执行器故障。";
  } catch (error) { $("list-detail").textContent = error.message; }
}

function showApproval(value) {
  approval = value;
  const box = $("approval"); box.classList.remove("hidden");
  const pairs = [
    ["链 / 代币", `${value.chain} · ${value.symbol} · ${value.address}`],
    ["策略", value.strategyId], ["计划金额", `${value.amountUsd} USD (${value.spendAsset})`],
    ["报价输入", value.inputAmount], ["报价输出", value.outputAmount], ["最低输出", value.minOutputAmount],
    ["滑点", value.slippage], ["钱包", value.wallet], ["GMGN 安全检查", `is_honeypot=false · rug_ratio=${value.security.rugRatio}`],
    ["止盈/止损", JSON.stringify(value.conditionOrders)], ["有效至", new Date(value.expiresAt).toLocaleTimeString()],
  ];
  const dl = $("preview"); dl.replaceChildren();
  for (const [key, val] of pairs) { const dt = document.createElement("dt"); dt.textContent = key; const dd = document.createElement("dd"); dd.textContent = String(val ?? "未知"); dl.append(dt, dd); }
  $("action-result").textContent = value.warning || "";
  $("confirm-text").value = ""; $("confirm").disabled = true;
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function prepare(candidateId, button) {
  button.disabled = true;
  try { const result = await postJson("/api/live-approval/prepare", { candidateId }); if (!result.ok) throw new Error(result.reason || "预览失败"); showApproval(result.approval); }
  catch (error) { $("list-detail").textContent = error.message; }
  finally { button.disabled = false; }
}

$("refresh").addEventListener("click", refresh);
$("confirm-text").addEventListener("input", () => { $("confirm").disabled = !approval || $("confirm-text").value !== "I_CONFIRM_THIS_TRADE"; });
$("cancel").addEventListener("click", async () => {
  if (approval) { try { await postJson("/api/live-approval/cancel", { approvalId: approval.id }); } catch {} }
  approval = null; $("approval").classList.add("hidden"); $("confirm-text").value = ""; await refresh();
});
$("confirm").addEventListener("click", async () => {
  if (!approval || $("confirm-text").value !== "I_CONFIRM_THIS_TRADE") return;
  const button = $("confirm"); button.disabled = true; $("action-result").textContent = "执行中；若结果未知请勿重试，先核对 GMGN 与账本。";
  try {
    const result = await postJson("/api/live-approval/confirm", { approvalId: approval.id, confirmation: $("confirm-text").value });
    $("action-result").textContent = result.ok ? `已提交 GMGN，订单 ${result.orderId || "ID 待核验"}，状态 ${result.status || "待核验"}。` : (result.reason || "已拒绝");
    approval = null; $("confirm-text").value = ""; await refresh();
  } catch (error) { $("action-result").textContent = error.message; }
  finally { button.disabled = true; }
});

await refresh();
setInterval(refresh, 5000);
