import fs from "node:fs/promises";
import path from "node:path";
import { Interface, getAddress, id, zeroPadValue } from "ethers";
import { readTokenMetadata } from "./detector.js";
import { isPonsSource } from "./source-controls.js";

const TRANSFER = id("Transfer(address,address,uint256)");
const SWAPS = new Set([id("Swap(address,uint256,uint256,uint256,uint256,address)"), id("Swap(address,address,int256,int256,uint160,uint128,int24)")]);
const ROUTE_TOKENS = new Set(["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"]);
const view = new Interface(["function owner() view returns(address)", "function treasury() view returns(address)", "function feeRecipient() view returns(address)"]);

const officialContracts = [
  ["Robinhood", "WETH", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", "token"],
  ["Robinhood", "USDG", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "token"],
  ["Robinhood", "L2 Gateway Router", "0x1E324B9316138CA9a73F960213621AD1aaf01B89", "protocol"],
  ["Robinhood", "L2 ERC20 Gateway", "0xfd9b17206278C16DdaacF6AC8f05dBf97EdCb31e", "protocol"],
  ["Robinhood", "L2 Custom Gateway", "0x912285144fC0f6e89d3Ed16F5Ab72f87A1878959", "protocol"],
  ["Robinhood", "L2 WETH Gateway", "0x1D187C3E2dA52D72BC9C41e3AbA0fdFa6a7bF055", "protocol"],
  ["Robinhood", "L2 Proxy Admin", "0xa3Acd31AFb851B4eB9DAD00F5204c01D924267dF", "admin"],
  ["Robinhood", "L2 Multicall", "0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1", "protocol"],
  ["Robinhood", "Permit2", "0x000000000022D473030F116dDEE9F6B43aC78BA3", "protocol"],
  ["Pons", "Active Factory", "0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB", "factory"],
  ["Pons", "Active Locker", "0x736D76699C26D0d966744cAe304C000d471f7F35", "locker"],
  ["Pons", "Legacy Factory", "0x0c37a24F5D23a486FA692d1500881d698B1F77a4", "factory"],
  ["Pons", "Legacy Locker", "0x31ca5E101941A93A7DD6d0497928700625CF54B5", "locker"],
  ["LaunchHood", "Factory", "0x62B33A039D289CBDa50EbeB72Fe4261449E61Bcf", "factory"],
  ["LaunchHood", "Locker", "0x99B79154Ff4Fc0e313549B809254B02722631ee0", "locker"],
  ["LaunchHood", "Token Implementation", "0x5FDf73abC7A232d91b03638c2f9a52c16aB0E3bE", "implementation"],
  ["LootPad", "V3 Launcher", "0x280996bdDCd10A6eEc637Bfb55bD60131f31aa59", "factory"],
  ["LootPad", "LP Locker", "0x25646EE317033aC35CcF325d23b0d9FD848F88A0", "locker"],
  ["LootPad", "LOOT", "0xbEF83DA2237be439d0BE0b50d452b89A6968B112", "token"],
  ["LootPad", "Staking", "0x5F0fF5edAAf670fa85B720C6839b80E158AB808c", "protocol"],
  ["LootPad", "V4 Fee Hook", "0x698975785F4e661a6e978b81754281d7bA710044", "hook"],
  ["LootPad", "V1 Launcher", "0x050c497B2A9ad79e64Cc8a7d8499206f909057ec", "factory"],
  ["LootPad", "Graduation Vault", "0x54d6c52Ad7182e116065F9f8B3918Da0D15B0BEd", "locker"],
  ["LootPad", "Legacy Token Template", "0x61247049542781b85B5635898B3Daf787bf09e50", "implementation"],
  ["Uniswap", "V3 Factory", "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA", "dex"],
  ["Uniswap", "Position Manager", "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3", "dex"],
  ["Uniswap", "Swap Router", "0xCaf681a66D020601342297493863E78C959E5cb2", "dex"],
  ["Uniswap", "V4 Pool Manager", "0x8366a39CC670B4001A1121B8F6A443A643e40951", "dex"],
].map(([project, role, address, type]) => ({ project, role, address: getAddress(address.toLowerCase()), type }));

const confirmedActors = [
  { address: "0xda4bCee76B29EFEc9697Fcf663601c2042043968", project: "Pons", role: "Legacy Factory owner", sourceContract: "0x0c37a24F5D23a486FA692d1500881d698B1F77a4" },
  { address: "0x73267feDc2C79a37782C19950b2989B208cfEaA4", project: "LaunchHood", role: "Factory owner", sourceContract: "0x62B33A039D289CBDa50EbeB72Fe4261449E61Bcf" },
  { address: "0x9608701dA2dcAE22f89d72dBa133167d15612bFB", project: "LootPad", role: "V1 Launcher owner", sourceContract: "0x050c497B2A9ad79e64Cc8a7d8499206f909057ec" },
];

async function callAddress(provider, address, method) {
  try {
    const raw = await Promise.race([
      provider.call({ to: address, data: view.encodeFunctionData(method) }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("eth_call timeout")), 5_000)),
    ]);
    const value = getAddress(view.decodeFunctionResult(method, raw)[0]);
    return /^0x0{40}$/i.test(value) ? null : value;
  } catch { return null; }
}

export async function buildOfficialCatalog(provider, dataDir, options = {}) {
  const ponsMonitorEnabled = options.ponsMonitorEnabled !== false;
  const catalogFile = path.join(dataDir, "official-addresses.json");
  const response = await fetch("https://api.robinhood.com/rhj/assets", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Robinhood asset registry HTTP ${response.status}`);
  const payload = await response.json();
  const stockTokens = (payload.assets || []).flatMap((asset) => (asset.deployments || []).filter((item) => Number(item.chainId) === 4663).map((item) => ({
    address: getAddress(item.contractAddress.toLowerCase()), symbol: asset.tokenSymbol, name: asset.tokenName, status: asset.status, source: "https://api.robinhood.com/rhj/assets",
  })));
  const activeContracts = officialContracts.filter((item) => ponsMonitorEnabled || !isPonsSource(item));
  const actorChecks = activeContracts.filter((item) => item.type === "factory").flatMap((contract) =>
    ["owner", "treasury", "feeRecipient"].map(async (method) => {
      const address = await callAddress(provider, contract.address, method);
      return address ? { address, project: contract.project, role: `${contract.role} ${method}`, sourceContract: contract.address } : null;
    }));
  const actors = (await Promise.all(actorChecks)).filter(Boolean);
  let preservedPonsActors = [];
  if (!ponsMonitorEnabled) {
    try {
      const previous = JSON.parse(await fs.readFile(catalogFile, "utf8"));
      preservedPonsActors = (previous.actors || []).filter(isPonsSource);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const catalog = {
    updatedAt: new Date().toISOString(),
    officialContracts,
    stockTokens,
    actors: [...new Map([...confirmedActors, ...actors, ...preservedPonsActors].map((item) => [item.address.toLowerCase(), item])).values()],
  };
  await fs.writeFile(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
  if (ponsMonitorEnabled) return catalog;
  return {
    ...catalog,
    officialContracts: catalog.officialContracts.filter((item) => !isPonsSource(item)),
    actors: catalog.actors.filter((item) => !isPonsSource(item)),
  };
}

const topicAddress = (address) => zeroPadValue(address, 32);
const decodedAddress = (topic) => getAddress(`0x${topic.slice(-40)}`);

export async function scanOfficialActivity(provider, fromBlock, toBlock, catalog) {
  const events = [];
  const actorTopics = catalog.actors.map((item) => topicAddress(item.address));
  if (actorTopics.length) {
    const [outgoing, incoming] = await Promise.all([
      provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER, actorTopics] }),
      provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER, null, actorTopics] }),
    ]);
    const actorMap = new Map(catalog.actors.map((item) => [item.address.toLowerCase(), item]));
    for (const [direction, logs] of [["outgoing", outgoing], ["incoming", incoming]]) {
      for (const log of logs) {
        if (ROUTE_TOKENS.has(log.address.toLowerCase())) continue;
        const actorAddress = direction === "outgoing" ? decodedAddress(log.topics[1]) : decodedAddress(log.topics[2]);
        const receipt = await provider.getTransactionReceipt(log.transactionHash);
        // Fee distributions and reward transfers often share a transaction with a
        // pool swap. Only the actor actually submitting the transaction is treated
        // as an official buy/sell; passive transfers remain in chain history only.
        if (receipt?.from?.toLowerCase() !== actorAddress.toLowerCase()) continue;
        if (!receipt?.logs.some((item) => SWAPS.has(item.topics[0]))) continue;
        const tokenMetadata = await readTokenMetadata(provider, log.address, log.blockNumber);
        const actor = actorMap.get(actorAddress.toLowerCase());
        events.push({ type: "official_activity", activity: direction === "incoming" ? "buy" : "sell", tradeVerified: true, project: actor.project, role: actor.role, actor: actorAddress, token: log.address, tokenMetadata, from: decodedAddress(log.topics[1]), to: decodedAddress(log.topics[2]), amount: BigInt(log.data).toString(), transactionHash: log.transactionHash, blockNumber: log.blockNumber });
      }
    }
  }
  return [...new Map(events.map((event) => [`${event.activity}:${event.transactionHash}:${event.token}:${event.actor || ""}`, event])).values()];
}
