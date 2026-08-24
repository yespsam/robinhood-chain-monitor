import test from "node:test";
import assert from "node:assert/strict";
import { chainSupportLabel, extractChainSupportSignals } from "../src/chain-support.js";

test("extracts explicit mainnet and testnet platform expansion", () => {
  assert.deepEqual(
    extractChainSupportSignals("Flap is now live on Base mainnet"),
    [{ id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "deployed" }],
  );
  assert.deepEqual(
    extractChainSupportSignals("Four.Meme adds support for Arbitrum Sepolia testnet"),
    [{ id: "arbitrum", name: "Arbitrum", chainId: null, environment: "testnet", stage: "supported" }],
  );
});

test("extracts chain ids and unnamed cross-chain expansion", () => {
  assert.deepEqual(
    extractChainSupportSignals("Uniswap protocol deployment is live on a new network, chainId: 999999"),
    [{ id: "chain-999999", name: "Chain ID 999999", chainId: 999999, environment: "unknown", stage: "deployed" }],
  );
  assert.equal(extractChainSupportSignals("Pools.trade announces multi-chain expansion")[0]?.id, "unspecified-new-chain");
});

test("extracts official network lists and structured chain ids only when explicitly enabled", () => {
  const text = 'Supported networks: BNB Chain, Base. supportedChains=[42161]';
  const chains = extractChainSupportSignals(text, { allowNetworkList: true });
  assert.deepEqual(chains.map((item) => item.name), ["Arbitrum", "Base", "BNB Chain"]);
  assert.deepEqual(extractChainSupportSignals('Community article about Base and chainId:42161'), []);
});

test("binds each chain to its nearest id and environment in a multi-chain sentence", () => {
  const chains = extractChainSupportSignals(
    "Flap adds support for Base mainnet (chainId: 8453), Arbitrum Sepolia (chainId: 421614), and Optimism mainnet (chainId: 10).",
  );
  assert.deepEqual(chains, [
    { id: "arbitrum", name: "Arbitrum", chainId: 421614, environment: "testnet", stage: "supported" },
    { id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "supported" },
    { id: "optimism", name: "Optimism", chainId: 10, environment: "mainnet", stage: "supported" },
  ]);
  assert.deepEqual(
    extractChainSupportSignals("Flap supports Base mainnet and Arbitrum Sepolia testnet."),
    [
      { id: "arbitrum", name: "Arbitrum", chainId: null, environment: "testnet", stage: "supported" },
      { id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "supported" },
    ],
  );
});

test("fails closed on chain-name/id conflicts and parses numeric and lowercase network schemas", () => {
  assert.deepEqual(extractChainSupportSignals("Flap supports Base mainnet, chainId: 42161."), []);
  assert.deepEqual(
    extractChainSupportSignals("supportedChains=[8453,42161,10]", { allowNetworkList: true }).map(({ name, chainId }) => ({ name, chainId })),
    [
      { name: "Arbitrum", chainId: 42161 },
      { name: "Base", chainId: 8453 },
      { name: "Optimism", chainId: 10 },
    ],
  );
  assert.deepEqual(
    extractChainSupportSignals("chains=[base,arbitrum,optimism]", { allowNetworkList: true }).map(({ name }) => name),
    ["Arbitrum", "Base", "Optimism"],
  );
  assert.deepEqual(
    extractChainSupportSignals('supportedNetworks=[{chainId:8453,name:"Base"}]', { allowNetworkList: true, structuredOnly: true }).map(({ name }) => name),
    ["Base"],
  );
});

test("removals and presentation copy stay silent while future plans are opt-in announced signals", () => {
  for (const text of [
    "Flap no longer supports Base mainnet",
    "Four.Meme removed Arbitrum support",
    "Update the Base chain selector icon",
    "Edit Base support documentation and README copy",
  ]) assert.deepEqual(extractChainSupportSignals(text), [], text);
  assert.deepEqual(extractChainSupportSignals("Flap plans to deploy on Base mainnet"), []);
  assert.deepEqual(
    extractChainSupportSignals("Flap plans to deploy on Base mainnet", { includeAnnounced: true }),
    [{ id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "announced" }],
  );
});

test("does not treat chain mentions, UI words, or token launches as platform support", () => {
  for (const text of [
    "We love the Base community",
    "Scroll is available in the settings panel",
    "New BASE token is live",
    "Trade TOKEN on Arbitrum",
    "A new pool for DOG on Base",
  ]) assert.deepEqual(extractChainSupportSignals(text), [], text);
});

test("keeps dotted platform names and official URLs in the action context", () => {
  const direct = extractChainSupportSignals("Pools.trade launches on Robinhood Chain");
  assert.equal(direct[0]?.name, "Robinhood Chain");
  const linked = extractChainSupportSignals("Pools.trade launches on Robinhood Chain https://blog.uniswap.org/pools-trade-launch");
  assert.equal(linked[0]?.name, "Robinhood Chain");
});

test("formats concise Chinese chain labels", () => {
  assert.equal(chainSupportLabel({ name: "Base", chainId: 8453, environment: "mainnet", stage: "deployed" }), "Base (8453) · 主网 · 已部署");
  assert.equal(chainSupportLabel({ name: "Solana", chainId: null, environment: "testnet", stage: "supported" }), "Solana · 测试网 · 已支持");
});
