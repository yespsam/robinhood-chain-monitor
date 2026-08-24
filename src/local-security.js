import { Interface, id, getAddress } from "ethers";

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1167_PREFIX = "363d3d373d3d3d363d73";
const EIP1167_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

const groups = {
  mint: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)"],
  blacklist: ["setBlacklist(address,bool)", "blacklist(address,bool)", "addBlacklist(address)", "setBot(address,bool)"],
  pause: ["pause()", "unpause()", "setPaused(bool)"],
  tax: ["setTax(uint256)", "setTaxes(uint256,uint256)", "setBuyTax(uint256)", "setSellTax(uint256)", "setFees(uint256,uint256)"],
  trading: ["enableTrading()", "setTradingEnabled(bool)", "openTrading()"],
  upgrade: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)"],
};

const selectors = Object.fromEntries(Object.entries(groups).map(([name, signatures]) => [name, signatures.map((signature) => id(signature).slice(2, 10))]));
const ownerInterface = new Interface(["function owner() view returns(address)"]);
const poolInterface = new Interface(["function liquidity() view returns(uint128)", "function getReserves() view returns(uint112,uint112,uint32)"]);

const hasSelector = (code, candidates) => candidates.some((selector) => code.includes(`63${selector}`));

function inspectMinimalProxy(code) {
  const normalized = String(code || "0x").toLowerCase().replace(/^0x/, "");
  // Runtime bytecode for an EIP-1167 clone begins with this prefix.  Do not
  // scan arbitrary bytecode for an embedded copy: clone factories commonly
  // contain the template as data and are not themselves minimal proxies.
  if (!normalized.startsWith(EIP1167_PREFIX)) return { detected: false, implementation: null };
  const implementationStart = EIP1167_PREFIX.length;
  const implementationHex = normalized.slice(implementationStart, implementationStart + 40);
  const suffix = normalized.slice(implementationStart + 40, implementationStart + 40 + EIP1167_SUFFIX.length);
  if (!/^[0-9a-f]{40}$/.test(implementationHex) || suffix !== EIP1167_SUFFIX) {
    return { detected: true, implementation: null };
  }
  if (/^0+$/.test(implementationHex)) return { detected: true, implementation: null };
  try {
    return { detected: true, implementation: getAddress(`0x${implementationHex}`) };
  } catch {
    return { detected: true, implementation: null };
  }
}

async function readOwner(provider, address) {
  try {
    const raw = await provider.call({ to: address, data: ownerInterface.encodeFunctionData("owner") });
    return getAddress(ownerInterface.decodeFunctionResult("owner", raw)[0]);
  } catch { return null; }
}

async function poolLiquidity(provider, pool) {
  if (!pool?.pool) return { confirmed: false, value: null };
  try {
    const kind = String(pool.kind || "").toLowerCase();
    if (kind.includes("v3") || kind.includes("infinity cl")) {
      const raw = await provider.call({ to: pool.pool, data: poolInterface.encodeFunctionData("liquidity") });
      const value = poolInterface.decodeFunctionResult("liquidity", raw)[0];
      return { confirmed: value > 0n, value: value.toString() };
    }
    const raw = await provider.call({ to: pool.pool, data: poolInterface.encodeFunctionData("getReserves") });
    const [reserve0, reserve1] = poolInterface.decodeFunctionResult("getReserves", raw);
    return { confirmed: reserve0 > 0n && reserve1 > 0n, value: `${reserve0}:${reserve1}` };
  } catch { return { confirmed: false, value: null }; }
}

export function evaluateLocalSecurity({
  code,
  owner,
  implementation,
  implementationResolved,
  proxyCode,
  proxyType,
  liquidity,
  sellability,
  buySellTax,
}) {
  const minimalProxy = inspectMinimalProxy(proxyCode || code);
  const detectedProxyType = proxyType || (minimalProxy.detected ? "eip1167" : implementation ? "eip1967" : null);
  const detectedImplementation = implementation || minimalProxy.implementation;
  const resolvedImplementation = implementationResolved ?? Boolean(implementation && !minimalProxy.detected);
  const normalizedCode = (code || "0x").toLowerCase().replace(/^0x/, "");
  const capabilities = Object.fromEntries(Object.entries(selectors).map(([name, values]) => [name, hasSelector(normalizedCode, values)]));
  const reasons = [];
  const warnings = [];
  if (!normalizedCode) reasons.push("合约代码缺失");
  if (capabilities.mint) reasons.push("检测到可增发入口");
  if (capabilities.blacklist) reasons.push("检测到黑名单/机器人名单入口");
  if (capabilities.pause) reasons.push("检测到暂停交易入口");
  if (capabilities.tax) reasons.push("检测到动态修改税费入口");
  if (capabilities.trading) reasons.push("检测到交易开关入口");
  if (capabilities.upgrade) reasons.push("检测到合约升级入口");
  if (detectedProxyType === "eip1167") {
    reasons.push("检测到 EIP-1167 最小代理");
    if (!detectedImplementation || !resolvedImplementation) reasons.push("代理实现合约未解析或代码未确认");
    if (sellability?.confirmed !== true || buySellTax?.verified !== true) reasons.push("代理代币的可卖性与买卖税费未验证");
  } else if (detectedImplementation) {
    reasons.push("合约可升级/代理实现");
  }
  if (owner && ![ZERO, DEAD].includes(owner.toLowerCase())) reasons.push(`Owner 未放弃: ${owner}`);
  if (!liquidity?.confirmed) reasons.push("池子实际流动性未确认");
  warnings.push("静态检查无法完全证明可卖，首次真实卖出前保持观察");
  return {
    decision: reasons.length ? "block" : "pass",
    label: reasons.length ? "不买" : "观察（权限/流动性初筛通过，可卖性未验证）",
    reasons, warnings,
    metrics: {
      owner,
      proxyType: detectedProxyType,
      proxyImplementation: detectedImplementation,
      implementationResolved: detectedProxyType ? Boolean(resolvedImplementation) : null,
      liquidityConfirmed: Boolean(liquidity?.confirmed),
      liquidity: liquidity?.value ?? null,
      capabilities,
      sellSimulation: "not_available",
      coverage: {
        bytecodeCapabilities: "static_selector_scan",
        owner: owner ? "detected" : "not_exposed_or_unreadable",
        proxy: detectedProxyType === "eip1167"
          ? resolvedImplementation ? "eip1167_implementation_resolved" : "eip1167_implementation_unresolved"
          : detectedImplementation ? "eip1967_implementation_detected" : "eip1967_slot_clear",
        liquidity: liquidity?.confirmed ? "confirmed_nonzero" : "not_confirmed",
        sellability: sellability?.confirmed === true ? "verified" : "not_checked",
        buySellTax: buySellTax?.verified === true ? "verified" : "not_checked",
        holderConcentration: "not_checked",
        lpLockOrBurn: "not_checked",
      },
    },
    checkedAt: new Date().toISOString(), source: "local_onchain",
  };
}

export async function assessLocalTokenSecurity(provider, address, pools = []) {
  try {
    const [code, owner, storage, liquidity] = await Promise.all([
      provider.getCode(address), readOwner(provider, address), provider.getStorage(address, EIP1967_IMPLEMENTATION_SLOT).catch(() => "0x"), poolLiquidity(provider, pools[0]),
    ]);
    const implementationHex = storage && storage !== "0x" ? storage.slice(-40) : "";
    const eip1967Implementation = implementationHex && !/^0+$/.test(implementationHex) ? getAddress(`0x${implementationHex}`) : null;
    const minimalProxy = inspectMinimalProxy(code);
    const proxyType = eip1967Implementation ? "eip1967" : minimalProxy.detected ? "eip1167" : null;
    const implementation = eip1967Implementation || minimalProxy.implementation;
    let implementationCode = null;
    let implementationResolved = false;
    if (implementation) {
      try {
        implementationCode = await provider.getCode(implementation);
        implementationResolved = typeof implementationCode === "string"
          && /^0x(?:[0-9a-f]{2})+$/i.test(implementationCode)
          && implementationCode !== "0x";
      } catch {
        implementationResolved = false;
      }
    }
    return evaluateLocalSecurity({
      code: implementationResolved ? implementationCode : code,
      proxyCode: code,
      owner,
      implementation,
      implementationResolved,
      proxyType,
      liquidity,
    });
  } catch (error) {
    return {
      decision: "unknown",
      label: "安全检查未完成",
      reasons: [`本地链上检查失败: ${error.message.slice(0, 120)}`],
      metrics: {
        sellSimulation: "not_available",
        coverage: {
          bytecodeCapabilities: "unknown",
          owner: "unknown",
          proxy: "unknown",
          liquidity: "unknown",
          sellability: "not_checked",
          buySellTax: "not_checked",
          holderConcentration: "not_checked",
          lpLockOrBurn: "not_checked",
        },
      },
      checkedAt: new Date().toISOString(),
      source: "local_onchain",
    };
  }
}
