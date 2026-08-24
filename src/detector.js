import { Interface, id, getAddress } from "ethers";
import { createHash } from "node:crypto";

const ZERO_TOPIC = `0x${"0".repeat(64)}`;
const TRANSFER = id("Transfer(address,address,uint256)");
const V2_PAIR_CREATED = id("PairCreated(address,address,address,uint256)");
const V3_POOL_CREATED = id("PoolCreated(address,address,uint24,int24,address)");
export const V4_INITIALIZE_TOPIC = id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const WRAPPED_NATIVE = new Set(["0x0bd7d308f8e1639fab988df18a8011f41eacad73"]);
const NON_TOKEN_MINT_EMITTERS = new Set(["0x73991a25c818bf1f1128deaab1492d45638de0d3"]);
const INFRA_MARKERS = {
  weth: "0bd7d308f8e1639fab988df18a8011f41eacad73",
  uniswapV3Factory: "1f7d7550b1b028f7571e69a784071f0205fd2efa",
  positionManager: "73991a25c818bf1f1128deaab1492d45638de0d3",
  swapRouter: "caf681a66d020601342297493863e78c959e5cb2",
};

export function bytecodeFeatures(code, infrastructureMarkers = INFRA_MARKERS) {
  const lower = code.toLowerCase().replace(/^0x/, "");
  const selectors = [...new Set([...lower.matchAll(/63([0-9a-f]{8})/g)].map((match) => match[1]))].sort();
  const infrastructure = Object.fromEntries(Object.entries(infrastructureMarkers).map(([name, address]) => [name, lower.includes(String(address).toLowerCase().replace(/^0x/, ""))]));
  let usesCreate = false;
  let usesCreate2 = false;
  for (let offset = 0; offset + 2 <= lower.length; ) {
    const opcode = Number.parseInt(lower.slice(offset, offset + 2), 16);
    offset += 2;
    if (opcode === 0xf0) usesCreate = true;
    if (opcode === 0xf5) usesCreate2 = true;
    if (opcode >= 0x60 && opcode <= 0x7f) offset += (opcode - 0x5f) * 2;
  }
  return {
    selectors,
    selectorCount: selectors.length,
    infrastructure,
    usesCreate,
    usesCreate2,
  };
}

export function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter((value) => b.has(value)).length;
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

export function parseRpcQuantity(value) {
  if (value === "0x" || value === "" || value === null || value === undefined) return 0n;
  return BigInt(value);
}

export function modeFamilyKey(shape) {
  return JSON.stringify({ selector: shape?.selector || "0x", poolKinds: [...new Set(shape?.poolKinds || [])].sort() });
}

export function classifyModeObservation(previous = {}, shape = {}) {
  const currentFamily = modeFamilyKey(shape);
  const familyCounts = new Map();
  for (const record of Object.values(previous.modes || {})) {
    const family = modeFamilyKey(record?.shape);
    familyCounts.set(family, (familyCounts.get(family) || 0) + Math.max(1, Number(record?.count || 0)));
  }
  const previousObservations = familyCounts.get(currentFamily) || 0;
  const distinctFamilies = familyCounts.size;
  let status;
  if (Number(previous.launches || 0) === 0) status = "baseline_mode";
  else if (previousObservations === 0) status = "new_mode_candidate";
  else if (distinctFamilies >= 2 && previousObservations === 1) status = "new_mode_confirmed";
  else status = "known_mode";
  return { status, currentFamily, previousObservations, distinctFamilies };
}

const erc20 = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function website() view returns (string)",
  "function twitter() view returns (string)",
  "function telegram() view returns (string)",
  "function discord() view returns (string)",
  "function description() view returns (string)",
]);
const v2 = new Interface(["event PairCreated(address indexed token0,address indexed token1,address pair,uint256)"]);
const v3 = new Interface(["event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)"]);
const v4 = new Interface(["event Initialize(bytes32 indexed poolId,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)"]);

const addressFromTopic = (topic) => getAddress(`0x${topic.slice(-40)}`);

export async function readTokenMetadata(provider, address, blockTag, extended = false) {
  const read = async (method) => {
    try {
      const raw = await provider.call({ to: address, data: erc20.encodeFunctionData(method), blockTag });
      return erc20.decodeFunctionResult(method, raw)[0];
    } catch {
      return null;
    }
  };
  const [name, symbol, decimals] = await Promise.all([read("name"), read("symbol"), read("decimals")]);
  if (name === null && symbol === null && decimals === null) return null;
  const [website, twitter, telegram, discord, description] = extended
    ? await Promise.all([read("website"), read("twitter"), read("telegram"), read("discord"), read("description")])
    : [null, null, null, null, null];
  return { name, symbol, decimals: decimals === null ? null : Number(decimals), website, twitter, telegram, discord, description };
}

export async function analyzeReceipt(provider, transaction, receipt, block, options = {}) {
  const includeTokenMetadata = options.includeTokenMetadata !== false;
  const wrappedNativeAddresses = new Set([...(options.wrappedNativeAddresses || WRAPPED_NATIVE)].map((address) => address.toLowerCase()));
  const ignoredMintEmitters = new Set([...(options.ignoredMintEmitters || NON_TOKEN_MINT_EMITTERS)].map((address) => address.toLowerCase()));
  const mints = new Map();
  const pools = [];

  for (const log of receipt.logs) {
    if (log.topics[0] === TRANSFER && log.topics.length === 3 && log.topics[1] === ZERO_TOPIC && /^0x[0-9a-fA-F]{64}$/.test(log.data || "")) {
      const amount = parseRpcQuantity(log.data);
      mints.set(log.address.toLowerCase(), {
        token: getAddress(log.address),
        recipient: addressFromTopic(log.topics[2]),
        amount: amount.toString(),
      });
    }
    try {
      if (log.topics[0] === V2_PAIR_CREATED) {
        const parsed = v2.parseLog(log);
        pools.push({ kind: "uniswap-v2", factory: getAddress(log.address), token0: parsed.args.token0, token1: parsed.args.token1, pool: parsed.args.pair });
      } else if (log.topics[0] === V3_POOL_CREATED) {
        const parsed = v3.parseLog(log);
        pools.push({ kind: "uniswap-v3", factory: getAddress(log.address), token0: parsed.args.token0, token1: parsed.args.token1, pool: parsed.args.pool, fee: Number(parsed.args.fee) });
      } else if (log.topics[0] === V4_INITIALIZE_TOPIC) {
        const parsed = v4.parseLog(log);
        pools.push({
          kind: "uniswap-v4",
          factory: getAddress(log.address),
          token0: parsed.args.currency0,
          token1: parsed.args.currency1,
          pool: null,
          poolId: parsed.args.poolId,
          hook: parsed.args.hooks,
          fee: Number(parsed.args.fee),
        });
      }
    } catch {
      // A malformed third-party log must not stop the scanner.
    }
  }

  // V2/V3 pool contracts emit their own zero-address Transfer while the LP
  // position is being created.  That is an LP token mint, not a newly
  // launched project token.  Parse pools first, then remove every concrete
  // pool address before probing ERC-20 metadata/creation history.
  const poolAddresses = new Set(pools.map((pool) => pool.pool?.toLowerCase()).filter(Boolean));
  for (const address of poolAddresses) mints.delete(address);

  let deployment = null;
  if (receipt.contractAddress) {
    const code = await provider.getCode(receipt.contractAddress, options.useLatestCodeForDeployment ? undefined : block.number);
    deployment = {
        type: "contract_deployed",
        contract: getAddress(receipt.contractAddress),
        deployer: getAddress(transaction.from),
        codeSize: (code.length - 2) / 2,
        bytecodeFeatures: bytecodeFeatures(code),
      };
  }

  const mintedTokens = (await Promise.all([...mints.values()].map(async (mint) => {
    if (wrappedNativeAddresses.has(mint.token.toLowerCase()) || ignoredMintEmitters.has(mint.token.toLowerCase())) return null;
    let isNewContract = new Set(options.knownNewContractAddresses || []).has(mint.token.toLowerCase());
    try {
      if (!isNewContract) isNewContract = block.number === 0 || (await provider.getCode(mint.token, block.number - 1)) === "0x";
    } catch {
      // A rate-limited public node may temporarily lack historical metadata.
    }
    return {
      ...mint,
      isNewContract,
      metadata: includeTokenMetadata ? await readTokenMetadata(provider, mint.token, block.number, isNewContract) : null,
    };
  }))).filter(Boolean);

  const caller = transaction.to ? getAddress(transaction.to) : null;
  let callerIsContract = options.assumeContractCaller === true;
  if (caller && !callerIsContract) callerIsContract = (await provider.getCode(caller)) !== "0x";
  const isKnownFactoryShape = mintedTokens.length && callerIsContract && (pools.length || mintedTokens.some((token) => token.isNewContract));
  const launch =
    isKnownFactoryShape
      ? {
          type: "token_launch",
          launcher: caller,
          deployer: getAddress(transaction.from),
          tokens: mintedTokens,
          pools,
          lifecycle: pools.length ? "completed_or_pool_native" : "new_creation_or_curve",
          confidence: pools.some((pool) => mintedTokens.some((mint) => [pool.token0, pool.token1].map((x) => x.toLowerCase()).includes(mint.token.toLowerCase())))
            ? "high"
            : pools.length
              ? "medium"
              : "low",
        }
      : null;

  if (launch) {
    const topicShape = [...new Set(receipt.logs.map((log) => log.topics[0]).filter(Boolean))].sort();
    const shape = {
      selector: transaction.data?.slice(0, 10) || "0x",
      poolKinds: [...new Set(pools.map((pool) => pool.kind))].sort(),
      mintCount: mintedTokens.length,
      logCount: receipt.logs.length,
      emitterCount: new Set(receipt.logs.map((log) => log.address.toLowerCase())).size,
      topicShape,
    };
    launch.mode = shape;
    launch.modeFingerprint = createHash("sha256").update(modeFamilyKey(shape)).digest("hex").slice(0, 16);
  }

  return { deployment, launch, pools, mintedTokens };
}
