const panel = document.querySelector("#fastDevRegistry");
const body = document.querySelector("#fastDevRegistryBody");

function line(text) {
  const node = document.createElement("p");
  node.className = "section-note";
  node.textContent = text;
  return node;
}

function table(headers, rows) {
  const wrap = document.createElement("div");
  wrap.className = "trades-scroll";
  const element = document.createElement("table");
  const head = document.createElement("tr");
  for (const header of headers) {
    const cell = document.createElement("th");
    cell.textContent = header;
    head.append(cell);
  }
  element.append(head);
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const value of row) {
      const cell = document.createElement("td");
      cell.textContent = value;
      tr.append(cell);
    }
    element.append(tr);
  }
  wrap.append(element);
  return wrap;
}

function when(ms) {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

async function render() {
  body.replaceChildren(line("正在读取本机记录…"));
  try {
    const [devs, hot] = await Promise.all([
      fetch("/api/fast-devs").then((response) => response.json()),
      fetch("/api/hot-narratives").then((response) => response.json()),
    ]);
    const nodes = [];
    const ranked = Array.isArray(devs?.ranked) ? devs.ranked : [];
    nodes.push(line(ranked.length
      ? `重复快开发 ${ranked.length} 个。中位延迟不超过 ${devs.maxMedianSeconds} 秒且至少 ${devs.minLaunches} 次记为正向信号。`
      : "还没有重复出现的快开发钱包。"));
    if (ranked.length) {
      nodes.push(table(
        ["排名", "链", "钱包", "次数", "中位秒", "最快秒", "正向"],
        ranked.map((row) => [String(row.rank), row.chain, row.wallet, String(row.count), String(row.medianLagSeconds), String(row.fastestLagSeconds), row.knownFast ? "是" : "否"]),
      ));
    }
    const rugs = Array.isArray(devs?.rugs) ? devs.rugs : [];
    if (rugs.length) nodes.push(line(`已标记跑路钱包 ${rugs.length} 个。开启 NARRATIVE_LIVE_BLOCK_RUG_DEVS 后会拒绝它们。`));
    const hotspots = Array.isArray(hot?.hotspots) ? hot.hotspots : [];
    nodes.push(line(hotspots.length ? `最近热点 ${hotspots.length} 条。` : "还没有热点记录。"));
    for (const hotspot of hotspots.slice(0, 8)) {
      const keywords = (hotspot.keywords || []).join(" / ") || "无关键词";
      const matches = (hotspot.matches || []).map((match) => `${match.symbol || match.name || match.address} +${match.lagSeconds}s`).join("，") || "尚无代币";
      nodes.push(line(`${hotspot.priority ? "优先 " : ""}${hotspot.author} · ${when(hotspot.publishedAt)} · ${keywords} · ${matches}`));
    }
    nodes.push(line("买入只在监控进程里、并且 NARRATIVE_LIVE_ENABLED=true 时发生。这个页面只展示记录。"));
    body.replaceChildren(...nodes);
  } catch {
    body.replaceChildren(line("本机热点记录暂不可用。"));
  }
}

panel?.addEventListener("toggle", () => {
  if (panel.open) void render();
});
