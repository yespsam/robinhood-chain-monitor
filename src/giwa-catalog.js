// Primary public sources checked on 2026-09-27. A website is not evidence of
// a mainnet deployment. Keep this registry separate from Robinhood factories.
export const GIWA_NETWORK = Object.freeze({
  name: "GIWA Sepolia", environment: "testnet", chainId: 91342,
  rpc: "https://sepolia-rpc.giwa.io/",
  explorer: "https://sepolia-explorer.giwa.io",
  mainnetStatus: "awaiting_official_network_parameters",
  mainnetChainId: null, tradingEnabled: false,
});

export const GIWA_SOURCES = Object.freeze([
  { id: "giwa-network", name: "GIWA 官方网络文档", kind: "network", url: "https://docs.giwa.io/giwa-chain/en/get-started/connect-to-giwa.md" },
  { id: "giwa-official-x", name: "GIWA 官方 X", kind: "official_x", url: "https://x.com/GIWA_by_Upbit" },
  { id: "giwa-home", name: "GIWA 官网", kind: "website", url: "https://giwa.io/home" },
  { id: "giwa-gasok", name: "GIWA 官方 GASOK 路线图", kind: "website", url: "https://giwa.io/gasok" },
  { id: "giwa-markets", name: "GIWA.MARKETS", kind: "website", url: "https://giwa.markets/" },
  { id: "giwa-markets-deployments", name: "GIWA.MARKETS 部署说明", kind: "deployments", url: "https://raw.githubusercontent.com/giupy997/launch-pad/main/README.md" },
  { id: "gasok", name: "Gasok", kind: "website", url: "https://gasok.fun/" },
  { id: "gasok-terms", name: "Gasok 网络说明", kind: "website", url: "https://gasok.fun/terms" },
  { id: "joseon", name: "Joseon.fun", kind: "website", url: "https://joseon.fun/" },
  { id: "gazua", name: "GAZUA", kind: "website", url: "https://gazua.xyz/" },
  { id: "memefab", name: "MemeFab", kind: "website", url: "https://memefab.fun/" },
  { id: "vezta", name: "Vezta 发射台文档", kind: "website", url: "https://docs.vezta.io/launchpad/overview" },
  { id: "lucrari", name: "Lucrari", kind: "website", url: "https://www.lucrari.xyz/", stageNote: "GIWA 测试网；主网部署待公布" },
  { id: "lucrari-docs", name: "Lucrari 文档", kind: "website", url: "https://docs.lucrari.xyz/", stageNote: "GIWA 测试网；第三方预设链 ID 不作主网依据" },
  { id: "hamr", name: "HAMR.fun", kind: "website", url: "https://hamr.fun/", stageNote: "目前官网显示 Robinhood；GIWA 接入待核验" },
  { id: "cookhouse", name: "CookHouse", kind: "website", url: "https://www.cookhouse.meme/", stageNote: "登记时为演示预览，不把样例成交当实盘" },
  { id: "gama", name: "GAMA", kind: "website", url: "https://gama.win/", stageNote: "登记时为候补名单，尚未验证发币合约" },
  { id: "kachi", name: "Kachi", kind: "website", url: "https://kachi.xyz/", stageNote: "登记时为 Coming soon，HTTP 503 不计作正常覆盖" },
].map(Object.freeze));

export const GIWA_TESTNET_FACTORIES = Object.freeze([
  { name: "Gasok", address: "0x54DD5E4756014E0a6BfE5ae08050Cf1a822fA91B", sourceId: "gasok", evidenceUrl: "https://gasok.fun/assets/index-CPdNfcOU.js" },
  { name: "GIWA.MARKETS", address: "0x8E1a1308E3b176528Ee9278d7a531F185F9fBeFD", sourceId: "giwa-markets-deployments", evidenceUrl: "https://github.com/giupy997/launch-pad" },
].map(Object.freeze));

// Discovery leads only: no verified endpoint, deployment, or coverage claim.
export const GIWA_PENDING_LEADS = Object.freeze([
  "cheomafun", "GiwaPump", "MapaeGiwa", "gasokfun",
  "Kimchifunxyz", "GIWAForge", "Flutchdotfun",
]);
