const entries = [
  {
    id: "anypad",
    name: "AnyPad",
    factories: ["0xa2763ec712a582a8450d7db932081ebfe8d951f8"],
    website: "https://anypad.fun",
    twitter: null,
    docs: null,
    model: "Uniswap V3 direct launch; early platform with incomplete public socials",
  },
  {
    id: "uniswap-pools",
    name: "Pools.trade (Uniswap Labs)",
    factories: [
      "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
      "0x05d552391067389ee44fec3924157ed33f976000",
      "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
      "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
      "0x1242c9439d589cae85e121b1f79f2af51e91dcee",
    ],
    website: "https://pools.trade",
    twitter: "https://x.com/TradePools",
    docs: "https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/",
    model: "Crowd Launch（4小时 TWAP 拍卖）或 Instant Launch（bonding curve）→ Uniswap v4 永久锁池并自动复投",
  },
  {
    id: "pons",
    name: "pons",
    factories: ["0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb", "0x0c37a24f5d23a486fa692d1500881d698b1f77a4"],
    website: "https://ponsfamily.com",
    twitter: "https://x.com/ponsdotfamily",
    docs: "https://docs.ponsfamily.com",
    model: "v1 Uniswap V3 pool-native；v2 bonding curve → Uniswap V4",
  },
  {
    id: "flap",
    name: "Flap",
    factories: [
      "0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09",
      "0xe9f7ab7de8fb8756acbb6a1cd13316a43308197b",
    ],
    website: "https://flap.sh",
    twitter: "https://x.com/flapdotsh",
    docs: "https://docs.flap.sh/flap",
    model: "Robinhood Portal/VaultPortal; standard, tax-token and vault launch modes",
  },
  {
    id: "launchhood",
    name: "LaunchHood",
    factories: ["0x62b33a039d289cbda50ebeb72fe4261449e61bcf"],
    website: "https://launchhood.com",
    twitter: "https://x.com/launchhood",
    docs: "https://launchhood.com/docs",
    model: "Uniswap V3 pool-native; permanent LP locker",
  },
  {
    id: "lootpad",
    name: "LootPad",
    factories: ["0x280996bddcd10a6eec637bfb55bd60131f31aa59"],
    website: "https://lootpad.tech",
    twitter: null,
    docs: "https://lootpad.tech/whitepaper",
    model: "Uniswap V3 concentrated launch curve; same-pool graduation",
  },
  {
    id: "noxa",
    name: "Noxa",
    factories: [],
    gmgnPlatforms: ["noxa"],
    website: "https://noxa.fi",
    twitter: "https://x.com/NoxaLaunchpad",
    docs: "https://docs.noxa.fi",
    model: "GMGN-indexed Robinhood launchpad",
  },
  {
    id: "bankr",
    name: "Bankr",
    factories: [],
    gmgnPlatforms: ["bankr"],
    website: "https://bankr.bot",
    twitter: null,
    docs: null,
    model: "GMGN-indexed agent launchpad",
  },
  {
    id: "virtuals",
    name: "Virtuals",
    factories: [],
    gmgnPlatforms: ["virtuals_v2"],
    website: "https://virtuals.io",
    twitter: null,
    docs: null,
    model: "GMGN-indexed V2 agent launchpad",
  },
];

export function monitoredLaunchpads() {
  return entries.map((entry) => publicLaunchpadProfile(entry));
}

export function launchpadFactoryAddresses() {
  return entries.flatMap((entry) => entry.factories || []);
}

export function launchpadByFactory(address) {
  const normalized = address?.toLowerCase();
  return entries.find((entry) => entry.factories?.includes(normalized)) || null;
}

export function launchpadByGmgnPlatform(platform) {
  return entries.find((entry) => entry.gmgnPlatforms?.includes(platform)) || null;
}

export function registerLaunchpadFactory(id, address) {
  const normalized = typeof address === "string" ? address.toLowerCase() : "";
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) return false;
  const entry = entries.find((item) => item.id === id);
  if (!entry) return false;
  entry.factories ||= [];
  if (entry.factories.includes(normalized)) return false;
  entry.factories.push(normalized);
  return true;
}

export function publicLaunchpadProfile(entry, match = "exact") {
  if (!entry) return null;
  return {
    id: entry.id,
    name: entry.name,
    website: entry.website,
    twitter: entry.twitter,
    docs: entry.docs,
    model: entry.model,
    match,
  };
}
