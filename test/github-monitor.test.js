import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_REPOSITORIES,
  GITHUB_PULL_REQUEST_TARGETS,
  PRIORITY_REPOSITORIES,
  classifyBinanceGithubChange,
  classifyFlapSkillChange,
  classifyGithubModeChange,
  createGithubMonitor,
  detectGithubChainSupportChange,
  extractBinanceConnectorChangeEvidence,
  extractGithubChangeEvidence,
  extractGithubDeploymentAddresses,
  isAcceptedAiGithubAlertDelivery,
  isUnverifiedPonsRepository,
  isRelevantModuleFile,
  isRelevantRepositoryFile,
  isSemanticallyRelevantAiChange,
  isSemanticallyRelevantBinanceChange,
  isSemanticallyRelevantFourMemeChange,
  isSemanticallyRelevantUniswapChange,
  parseGithubAtom,
  parseGithubPatchFiles,
  parseGithubPatchMessage,
  parseGithubRepositoryPage,
  summarizeGithubChange,
} from "../src/github-monitor.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";
import { sendAlerts } from "../src/alerts.js";

const githubFixture = (name) => fs.readFile(new URL(`./fixtures/github/${name}`, import.meta.url), "utf8");

test("detects structural chain additions for the three focus platforms and filters documentation noise", () => {
  const flap = detectGithubChainSupportChange("flap-sh/FlapVaultExample", "feat: deploy Base mainnet", [{
    filename: "deployments/base/addresses.json",
    status: "added",
    patch: "+{ \"chainId\": 8453, \"factory\": \"0x1111111111111111111111111111111111111111\" }",
  }]);
  assert.equal(flap.candidate, true);
  assert.equal(flap.stage, "commit");
  assert.deepEqual(flap.chains.map(({ name, chainId, environment }) => ({ name, chainId, environment })), [
    { name: "Base", chainId: 8453, environment: "mainnet" },
  ]);

  const four = detectGithubChainSupportChange("four-meme-community/four-meme-ai", "feat: support Arbitrum Sepolia", [{
    filename: "config/chains.ts",
    status: "modified",
    patch: "+export const arbitrumSepolia = { chainId: 421614, environment: \"testnet\" };",
  }], { stage: "pr" });
  assert.equal(four.candidate, true);
  assert.deepEqual(four.chains.map(({ name, chainId, environment }) => ({ name, chainId, environment })), [
    { name: "Arbitrum", chainId: 421614, environment: "testnet" },
  ]);
  assert.equal(four.stage, "pr");

  const uniswap = detectGithubChainSupportChange("Uniswap/liquidity-launcher", "add chain 999999 deployment", [{
    filename: "script/deploy/999999/DeployLauncher.s.sol",
    status: "added",
    patch: "+uint256 constant CHAIN_ID = 999999;",
  }]);
  assert.deepEqual(uniswap.chains.map(({ name, chainId, environment }) => ({ name, chainId, environment })), [
    { name: "Chain ID 999999", chainId: 999999, environment: "unknown" },
  ]);

  for (const files of [
    [{ filename: "README.md", status: "modified", patch: "+Now available on Base mainnet (chainId 8453)." }],
    [{ filename: "assets/chains/base.svg", status: "added", patch: "+<svg>Base</svg>" }],
    [{ filename: "pnpm-lock.yaml", status: "modified", patch: "+base: 8453" }],
    [{ filename: "config/chains.ts", status: "modified", patch: "-base,\n+base," }],
  ]) {
    assert.equal(detectGithubChainSupportChange("Uniswap/liquidity-launcher", "docs: update supported chains", files).candidate, false);
  }
  assert.equal(detectGithubChainSupportChange("flap-sh/FlapVaultExample", "feat: add VaultBaseV3", [{
    filename: "contracts/VaultBaseV3.sol",
    status: "added",
    patch: "+contract VaultBaseV3 is VaultBaseV2 {}",
  }]).candidate, false);
});

test("Uniswap chain detection ignores salts metadata numbers and keeps only the new Ink deployment", () => {
  const result = detectGithubChainSupportChange(
    "Uniswap/UniswapX",
    "feat: deploy DutchV3 reactor + OrderQuoter to Ink (57073) (#375)",
    [{
      filename: "playbook/chains/salts.json",
      status: "modified",
      patch: [
        '+    "_comment": "First mined for Robinhood (4663) and reused for Ink (57073).",',
        '+      "_saltNote": "Robinhood is Arbitrum Orbit and Ink reuses the pair.",',
        '+      "minedAt": "2026-06-12T23:10:10Z",',
        '+      "minedZeroBytes": "4 leading + 5 total",',
        '+    "57073": {',
        '+      "name": "ink",',
        '+      "poolManager": "0x360e68faccca8ca495c1b759fd9eee466db9fb32"',
      ].join("\n"),
    }],
  );
  assert.equal(result.candidate, true);
  assert.deepEqual(result.chains.map(({ name, chainId, environment }) => ({ name, chainId, environment })), [
    { name: "Ink", chainId: 57073, environment: "mainnet" },
  ]);
});

test("prioritizes official Uniswap protocol repositories and suppresses generated or equity noise", () => {
  const configured = new Map(DEFAULT_REPOSITORIES.map((entry) => [entry.repository.toLowerCase(), entry]));
  for (const repository of [
    "uniswap/liquidity-launcher",
    "uniswap/v4-hooks-public",
    "uniswap/hooklist",
    "uniswap/protocol-fees",
    "uniswap/contracts",
    "uniswap/uniswapx",
  ]) {
    assert.equal(configured.get(repository)?.sourceTrust, "official_verified");
    assert.equal(configured.get(repository)?.baselineOnly, true);
    assert.equal(Object.hasOwn(configured.get(repository), "chainId"), false);
    assert.equal(PRIORITY_REPOSITORIES.has(repository), true);
  }
  assert.equal(isRelevantRepositoryFile("Uniswap/hooklist", "hooks/robinhood/0x123.json"), true);
  assert.equal(isSemanticallyRelevantUniswapChange("Uniswap/liquidity-launcher", { commit: { message: "add InstantLaunchStrategy" } }, [
    { filename: "src/strategies/InstantLaunchStrategy.sol", status: "added", patch: "+contract InstantLaunchStrategy {}" },
  ]), true);
  assert.equal(isSemanticallyRelevantUniswapChange("Uniswap/contracts", { commit: { message: "deploy MixedRouteQuoterV2" } }, [
    { filename: "deployments/4663.json", status: "modified", patch: "+\"MixedRouteQuoterV2\": \"0x1111111111111111111111111111111111111111\"" },
  ]), true);
  assert.equal(isSemanticallyRelevantUniswapChange("Uniswap/hooklist", { commit: { message: "regenerate hooklist" } }, [
    { filename: "hooklist.json", status: "modified", patch: "+generated" },
  ]), false);
  assert.equal(isSemanticallyRelevantUniswapChange("Uniswap/hooklist", { commit: { message: "add EquityLaunch hook" } }, [
    { filename: "hooks/robinhood/0xequity.json", status: "added", patch: "+tokenized stock issuance" },
  ]), false);
});

test("GitHub module filter keeps contract modules and ignores media/docs", () => {
  assert.equal(isRelevantModuleFile("contracts/src/PonsLaunchFactory.sol"), true);
  assert.equal(isRelevantModuleFile("sdk/client.ts"), true);
  assert.equal(isRelevantModuleFile("abi.json"), true);
  assert.equal(isRelevantModuleFile("README.md"), false);
  assert.equal(isRelevantModuleFile("media/ponso.png"), false);
});

test("tracks official Binance Wallet, API, and social-trading code changes", () => {
  const configured = new Map(DEFAULT_REPOSITORIES.map((entry) => [entry.repository.toLowerCase(), entry]));
  for (const repository of [
    "binance/binance-skills-hub",
    "binance/binance-web3-connector-js",
    "binance/binance-web3-connector-python",
    "binance/binance-web3-connector-java",
    "binance/binance-cli",
    "binance/binance-spot-api-docs",
    "binance/binance-api-swagger",
  ]) {
    assert.equal(configured.get(repository)?.sourceTrust, "official_verified");
    assert.equal(configured.get(repository)?.baselineOnly, true);
    assert.equal(PRIORITY_REPOSITORIES.has(repository), true);
  }
  const regularGoConnector = configured.get("binance/binance-connector-go");
  assert.equal(regularGoConnector?.sourceTrust, "official_verified");
  assert.equal(regularGoConnector?.baselineOnly, true);
  assert.deepEqual(regularGoConnector?.officialEvidence, {
    source: "official_binance_github",
    url: "https://github.com/binance",
  });
  assert.equal(regularGoConnector?.priority, undefined);
  assert.equal(PRIORITY_REPOSITORIES.has("binance/binance-connector-go"), false);
  assert.equal(isRelevantRepositoryFile("binance/binance-web3-connector-js", "clients/web3-wallet/src/rest-api/modules/new-chain.ts"), true);
  assert.equal(isRelevantRepositoryFile("binance/binance-web3-connector-js", "clients/spot/src/trading.ts"), false);
  assert.equal(isSemanticallyRelevantBinanceChange("binance/binance-skills-hub", { commit: { message: "docs" } }, [{ filename: "skills/binance-web3/meme-rush/SKILL.md", status: "modified" }]), true);
  assert.equal(isSemanticallyRelevantBinanceChange("binance/binance-skills-hub", { commit: { message: "new payment helper" } }, [{ filename: "skills/binance/payment/SKILL.md", status: "added", patch: "+card payment" }]), false);
  assert.equal(isSemanticallyRelevantBinanceChange("binance/binance-skills-hub", { commit: { message: "add launchpad adapter" } }, [{ filename: "skills/binance-web3/new-launchpad/SKILL.md", status: "added", patch: "+new chain and bonding curve launchpad" }]), true);
  assert.equal(isSemanticallyRelevantBinanceChange("binance/binance-skills-hub", { commit: { message: "add KOL call sharing skill" } }, [{ filename: "skills/binance-web3/trading-signal/SKILL.md", status: "added", patch: "+share KOL buys and copy smart money signals" }]), true);
  assert.equal(isSemanticallyRelevantBinanceChange("binance/binance-spot-api-docs", { commit: { message: "feat: add new WebSocket endpoint" } }, [{ filename: "CHANGELOG.md", status: "modified", patch: "+Added a new WebSocket API endpoint" }]), true);
  for (const message of [
    "Publish Agent OS",
    "Add Binance MCP Server",
    "Release Agent Native runtime",
  ]) {
    assert.equal(isSemanticallyRelevantBinanceChange("binance/agent-platform", { commit: { message } }, [{
      filename: "README.md",
      status: "modified",
      patch: `+${message}`,
    }]), true, message);
  }
  assert.equal(isSemanticallyRelevantBinanceChange("binance/binance-spot-api-docs", { commit: { message: "docs: fix typo" } }, [{ filename: "README.md", status: "modified", patch: "+spelling fixed" }]), false);
});

test("tracks only the explicit official X and xAI GitHub repositories with strict product semantics", () => {
  const configured = new Map(DEFAULT_REPOSITORIES.map((entry) => [entry.repository.toLowerCase(), entry]));
  const xaiRepositories = [
    "xai-org/grok-build",
    "xai-org/grok-build-plugin-cc",
    "xai-org/plugin-marketplace",
    "xai-org/xai-sdk-python",
    "xai-org/xai-proto",
    "xai-org/x-algorithm",
    "xai-org/grok-prompts",
  ];
  const xRepositories = [
    "xdevplatform/chat-xdk",
    "xdevplatform/xurl",
    "xdevplatform/xmcp",
    "xdevplatform/xdk",
    "xdevplatform/xdk-python",
    "xdevplatform/xdk-typescript",
  ];
  for (const repository of xaiRepositories) {
    const entry = configured.get(repository);
    assert.equal(entry?.sourceTrust, "official_verified");
    assert.equal(entry?.baselineOnly, true);
    assert.equal(entry?.xaiOfficial, true);
    assert.deepEqual(entry?.product, repository === "xai-org/x-algorithm"
      ? { id: "x", name: "X" }
      : { id: "grok", name: "xAI / Grok" });
    assert.equal(entry?.launchpad, entry?.product.name);
  }
  for (const repository of xRepositories) {
    const entry = configured.get(repository);
    assert.equal(entry?.sourceTrust, "official_verified");
    assert.equal(entry?.baselineOnly, true);
    assert.equal(entry?.xaiOfficial, true);
    assert.deepEqual(entry?.product, { id: "x-api", name: "X API / Developer Platform" });
    assert.equal(entry?.launchpad, "X");
  }
  for (const repository of [
    "xai-org/grok-build",
    "xai-org/plugin-marketplace",
    "xai-org/xai-sdk-python",
    "xdevplatform/xdk",
  ]) assert.equal(PRIORITY_REPOSITORIES.has(repository), true);
  for (const repository of [
    "xai-org/xai-proto",
    "xdevplatform/chat-xdk",
    "xdevplatform/xdk-python",
    "xdevplatform/xdk-typescript",
  ]) assert.equal(PRIORITY_REPOSITORIES.has(repository), false);
  assert.equal(DEFAULT_REPOSITORIES.filter((entry) => entry.xaiOfficial && entry.priority === true).length, 4);
  const pullRequestTargets = new Set(GITHUB_PULL_REQUEST_TARGETS.map((repository) => repository.toLowerCase()));
  for (const repository of [...xaiRepositories, ...xRepositories]) assert.equal(pullRequestTargets.has(repository), false);

  assert.equal(isRelevantRepositoryFile("xai-org/xai-sdk-python", "src/xai_sdk/chat.py"), true);
  assert.equal(isRelevantRepositoryFile("xai-org/plugin-marketplace", ".claude-plugin/marketplace.json"), true);
  assert.equal(isRelevantRepositoryFile("xdevplatform/xdk-typescript", "packages/xdk/src/client.ts"), true);
  assert.equal(isRelevantRepositoryFile("xai-org/grok-build", "assets/logo.png"), false);

  assert.equal(isSemanticallyRelevantAiChange("xai-org/xai-sdk-python", { commit: { message: "feat: add Grok 5 chat API endpoint" } }, [
    { filename: "src/xai_sdk/chat.py", status: "modified", patch: "+class Grok5ChatEndpoint: pass" },
  ]), true);
  assert.equal(isSemanticallyRelevantAiChange("xdevplatform/xdk", { commit: { message: "release v1.4.0" } }, [
    { filename: "package.json", status: "modified", patch: '-"version": "1.3.0"\n+"version": "1.4.0"' },
  ]), true);
  assert.equal(isSemanticallyRelevantAiChange("xai-org/xai-proto", { commit: { message: "deprecate legacy API endpoint" } }, [
    { filename: "proto/xai/api.proto", status: "modified", patch: "+option deprecated = true;" },
  ]), true);
  assert.equal(isSemanticallyRelevantAiChange("xdevplatform/chat-xdk", { commit: { message: "security: fix authentication bypass in chat API" } }, [
    { filename: "src/auth.ts", status: "modified", patch: "+verifyAuthorization(request);" },
  ]), true);
  assert.equal(isSemanticallyRelevantAiChange("xdevplatform/xdk", { commit: { message: "docs: add new SDK endpoint" } }, [
    { filename: "CHANGELOG.md", status: "modified", patch: "+New SDK endpoint: createPost" },
  ]), true);

  assert.equal(isSemanticallyRelevantAiChange("xai-org/xai-sdk-python", { commit: { message: "docs: fix typo" } }, [
    { filename: "README.md", status: "modified", patch: "+Correct spelling" },
  ]), false);
  assert.equal(isSemanticallyRelevantAiChange("xai-org/xai-sdk-python", { commit: { message: "test: add new API endpoint coverage" } }, [
    { filename: "tests/test_chat.py", status: "added", patch: "+def test_new_endpoint(): pass" },
  ]), false);
  assert.equal(isSemanticallyRelevantAiChange("xdevplatform/xdk-typescript", { commit: { message: "deps: dependency bump" } }, [
    { filename: "package-lock.json", status: "modified", patch: "+lockfileVersion: 3" },
  ]), false);
  assert.equal(isSemanticallyRelevantAiChange("xdevplatform/xdk", { commit: { message: "refactor: reorganize SDK client" } }, [
    { filename: "src/client.ts", status: "modified", patch: "+export class Client {}" },
  ]), false);
  assert.equal(isSemanticallyRelevantAiChange("untrusted/xai-clone", { commit: { message: "docs: fix typo" } }, [
    { filename: "README.md", status: "modified", patch: "+typo" },
  ]), true, "non-allowlisted repositories retain the generic monitor semantics");
});

test("official xAI commits baseline silently then emit a strong product event without launchpad mode classification", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-xai-baseline-"));
  const repository = "xai-org/xai-sdk-python";
  const entry = DEFAULT_REPOSITORIES.find(({ repository: candidate }) => candidate === repository);
  const alerts = [];
  let latest = "aaaa5001";
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(".atom")) {
      const previous = latest === "bbbb5002"
        ? `<entry><id>tag:github.com,2008:Grit::Commit/aaaa5001</id><updated>2026-08-12T00:00:00Z</updated><title>existing code</title></entry>`
        : "";
      return {
        ok: true,
        status: 200,
        text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/${latest}</id><updated>2026-08-12T00:01:00Z</updated><title>${latest === "bbbb5002" ? "feat: add Grok 5 chat API endpoint" : "existing code"}</title></entry>${previous}</feed>`,
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "diff --git a/src/xai_sdk/chat.py b/src/xai_sdk/chat.py\n--- a/src/xai_sdk/chat.py\n+++ b/src/xai_sdk/chat.py\n+class Grok5ChatEndpoint: pass",
    };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [entry],
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "queued" }; },
    now: () => new Date("2026-08-12T00:02:00Z"),
  });

  await monitor.check(true);
  assert.equal(alerts.length, 0);
  latest = "bbbb5002";
  await monitor.check(true);

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "github_module_update");
  assert.equal(alerts[0].launchpad, "xAI / Grok");
  assert.deepEqual(alerts[0].product, { id: "grok", name: "xAI / Grok" });
  assert.equal(alerts[0].xaiOfficial, true);
  assert.equal(alerts[0].sourceTrust, "official_verified");
  assert.equal(alerts[0].strong, true);
  assert.equal(alerts[0].productChange.candidate, true);
  assert.equal(alerts[0].productChange.reason, "new_ai_product_or_feature");
  assert.equal(alerts[0].productChange.category, "model");
  assert.equal(alerts[0].productChange.stage, "code_change");
  assert.ok(alerts[0].productChange.identifiers.some((identifier) => /^grok 5/i.test(identifier)));
  assert.equal(alerts[0].modeChange, undefined);
  assert.deepEqual(alerts[0].newContracts, []);
});

test("AI GitHub delivery accepts durable queue states and terminal suppressions only", () => {
  assert.equal(isAcceptedAiGithubAlertDelivery(undefined), true);
  assert.equal(isAcceptedAiGithubAlertDelivery({ status: "queued" }), true);
  assert.equal(isAcceptedAiGithubAlertDelivery({ status: "delivered" }), true);
  for (const reason of [
    "freshness_too_old",
    "not_relevant",
    "monitoring_source_disabled",
    "blocked_event",
    "semantic_duplicate",
  ]) {
    assert.equal(isAcceptedAiGithubAlertDelivery({ status: "suppressed", reason }), true, reason);
  }
  assert.equal(isAcceptedAiGithubAlertDelivery({ status: "suppressed", reason: "future_terminal_policy", terminal: true }), true);
  assert.equal(isAcceptedAiGithubAlertDelivery({ status: "suppressed", reason: "freshness_too_old", terminal: false }), false);
  assert.equal(isAcceptedAiGithubAlertDelivery({ status: "suppressed", reason: "freshness_too_old", disposition: "retry" }), false);
  assert.equal(isAcceptedAiGithubAlertDelivery({ status: "suppressed", reason: "unknown_policy" }), false);
  assert.equal(isAcceptedAiGithubAlertDelivery(false), false);
  assert.equal(isAcceptedAiGithubAlertDelivery(true), false);
  for (const status of ["failed", "error", "rejected", "dropped"]) {
    assert.equal(isAcceptedAiGithubAlertDelivery({ status }), false, status);
  }
  for (const reason of ["monitoring_source_disabled", "not_relevant", "blocked_event"]) {
    assert.equal(isAcceptedAiGithubAlertDelivery({ status: "queued", reason }), false, reason);
  }
});

test("a terminally suppressed old AI commit advances its SHA and does not replay after restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-xai-alert-retry-"));
  const repository = "xai-org/xai-sdk-python";
  const entry = DEFAULT_REPOSITORIES.find(({ repository: candidate }) => candidate === repository);
  let current = new Date("2026-08-12T03:00:00.000Z");
  let attempts = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: "aaaa7001", checkedAt: "2026-08-12T02:59:00.000Z" },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(".atom")) {
      return {
        ok: true,
        status: 200,
        text: async () => `<feed>
          <entry><id>tag:github.com,2008:Grit::Commit/bbbb7002</id><updated>2026-08-12T03:00:00Z</updated><title>feat: add Grok 5 Responses API endpoint</title></entry>
          <entry><id>tag:github.com,2008:Grit::Commit/aaaa7001</id><updated>2026-08-12T02:59:00Z</updated><title>old</title></entry>
        </feed>`,
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "diff --git a/src/xai_sdk/responses.py b/src/xai_sdk/responses.py\n+++ b/src/xai_sdk/responses.py\n+class Grok5ResponsesApi: pass",
    };
  });
  const createMonitor = () => createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [entry],
    now: () => new Date(current),
    sendAlertsImpl: async () => {
      attempts += 1;
      return { status: "suppressed", reason: "freshness_too_old", disposition: "terminal", terminal: true };
    },
  });

  const monitor = createMonitor();
  await monitor.check(true);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(attempts, 1);
  assert.equal(state[repository].sha, "bbbb7002");
  assert.equal(state._health.repositories[repository].status, "healthy");

  current = new Date("2026-08-12T03:00:01.000Z");
  const restartedMonitor = createMonitor();
  await restartedMonitor.check(true);
  current = new Date("2026-08-12T03:00:02.000Z");
  await restartedMonitor.check(true);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(attempts, 1, "a terminal policy decision must not replay across restart or continuous polls");
  assert.equal(state[repository].sha, "bbbb7002");
  assert.equal(state._health.repositories[repository].status, "healthy");
});

test("retryable, unknown, and thrown AI delivery failures keep the previous SHA", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-xai-alert-nondurable-"));
  const repository = "xai-org/xai-sdk-python";
  const entry = DEFAULT_REPOSITORIES.find(({ repository: candidate }) => candidate === repository);
  let current = new Date("2026-08-12T04:00:00.000Z");
  let attempts = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: "aaaa8001", checkedAt: "2026-08-12T03:59:00.000Z" },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(".atom")) {
      return {
        ok: true,
        status: 200,
        text: async () => `<feed>
          <entry><id>tag:github.com,2008:Grit::Commit/bbbb8002</id><updated>2026-08-12T04:00:00Z</updated><title>feat: add Grok 5 Responses API endpoint</title></entry>
          <entry><id>tag:github.com,2008:Grit::Commit/aaaa8001</id><updated>2026-08-12T03:59:00Z</updated><title>old</title></entry>
        </feed>`,
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "diff --git a/src/xai_sdk/responses.py b/src/xai_sdk/responses.py\n+++ b/src/xai_sdk/responses.py\n+class Grok5ResponsesApi: pass",
    };
  });
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    githubRetryBaseMs: 1_000,
    githubRetryMaxMs: 8_000,
  }, {
    autoStart: false,
    repositories: [entry],
    now: () => new Date(current),
    random: () => 0.5,
    sendAlertsImpl: async () => {
      attempts += 1;
      if (attempts === 1) return { status: "suppressed", reason: "delivery_backpressure", disposition: "retry" };
      if (attempts === 2) return { status: "suppressed", reason: "unknown_policy" };
      if (attempts === 3) throw new Error("delivery unavailable");
      return { status: "queued", eventId: "github:xai-sdk-python:bbbb8002" };
    },
  });

  for (const milliseconds of [0, 1_000, 3_000]) {
    current = new Date(Date.parse("2026-08-12T04:00:00.000Z") + milliseconds);
    await monitor.check(true);
    const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
    assert.equal(state[repository].sha, "aaaa8001");
    assert.equal(state._health.repositories[repository].status, "degraded");
  }

  current = new Date("2026-08-12T04:00:07.000Z");
  await monitor.check(true);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(attempts, 4);
  assert.equal(state[repository].sha, "bbbb8002");
  assert.equal(state._health.repositories[repository].status, "healthy");
});

test("official Binance commits advance SHA only after a durable alert acceptance", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-binance-alert-durable-"));
  const repository = "binance/binance-skills-hub";
  const entry = DEFAULT_REPOSITORIES.find(({ repository: candidate }) => candidate === repository);
  let current = new Date("2026-08-20T05:00:00.000Z");
  let attempts = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: "aaaa9001", checkedAt: "2026-08-20T04:59:00.000Z" },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(".atom")) {
      return {
        ok: true,
        status: 200,
        text: async () => `<feed>
          <entry><id>tag:github.com,2008:Grit::Commit/bbbb9002</id><updated>2026-08-20T05:00:00Z</updated><title>feat: add Binance Web3 launchpad skill</title></entry>
          <entry><id>tag:github.com,2008:Grit::Commit/aaaa9001</id><updated>2026-08-20T04:59:00Z</updated><title>old</title></entry>
        </feed>`,
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "diff --git a/skills/binance-web3/new-launchpad/SKILL.md b/skills/binance-web3/new-launchpad/SKILL.md\nnew file mode 100644\n--- /dev/null\n+++ b/skills/binance-web3/new-launchpad/SKILL.md\n+New Web3 launchpad and bonding curve integration",
    };
  });
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    githubRetryBaseMs: 1_000,
    githubRetryMaxMs: 8_000,
  }, {
    autoStart: false,
    repositories: [entry],
    now: () => new Date(current),
    random: () => 0.5,
    sendAlertsImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? { status: "suppressed", reason: "delivery_backpressure", disposition: "retry" }
        : { status: "queued", eventId: "github:binance-skills-hub:bbbb9002" };
    },
  });

  await monitor.check(true);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(attempts, 1);
  assert.equal(state[repository].sha, "aaaa9001");
  assert.equal(state._health.repositories[repository].status, "degraded");

  current = new Date("2026-08-20T05:00:01.000Z");
  await monitor.check(true);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(attempts, 2);
  assert.equal(state[repository].sha, "bbbb9002");
  assert.equal(state._health.repositories[repository].status, "healthy");
});

test("BSC launchpad repositories start from silent baselines and XFOUR stays a candidate", () => {
  const configured = new Map(DEFAULT_REPOSITORIES.map((entry) => [entry.repository.toLowerCase(), entry]));
  for (const repository of [
    "hodldance/hodl-dance",
    "moonsaleapp/moonsaleapp",
    "huksdotfun/bsc-contracts",
    "fetchai/agent-launch-toolkit",
    "flazepad-xyz/flazepad-core",
    "karmafionbnb/karmafi",
    "pqchase/rugspull",
    "createtokenco/bep20standardtoken",
    "onchain365/magic-mint-contracts",
    "codeless-dev/codelessdev-contracts",
  ]) {
    assert.equal(configured.get(repository)?.sourceTrust, "official_verified");
    assert.equal(configured.get(repository)?.baselineOnly, true);
  }
  assert.equal(configured.get("xbsc-402/402bnb-contract")?.sourceTrust, "unverified_candidate");
  assert.equal(configured.has("poodotmeme/poo.meme"), false);
  assert.equal(configured.has("bnbpumpfun/contracts"), false);
  assert.equal(isRelevantRepositoryFile("createtokenco/bep20standardtoken", "README.md"), true);
  assert.equal(isRelevantRepositoryFile("hodldance/hodl-dance", "README.md"), true);
  assert.equal(isRelevantRepositoryFile("karmafionbnb/karmafi", "SECURITY-REVIEW.md"), true);
  assert.equal(isRelevantRepositoryFile("karmafionbnb/karmafi", "SECURITY.md"), true);
  assert.equal(isRelevantRepositoryFile("hodldance/hodl-dance", "docs/INTEGRATION.md"), true);
  assert.equal(isRelevantRepositoryFile("random/project", "README.md"), false);
});

test("GitHub deployment extraction keeps platform roles and rejects quote/testnet addresses", () => {
  assert.deepEqual(extractGithubDeploymentAddresses([
    "+ BSC mainnet Factory: 0x1111111111111111111111111111111111111111",
    "+ quote token: 0x2222222222222222222222222222222222222222",
    "+ BSC testnet Hook: 0x3333333333333333333333333333333333333333",
    "+ Manager proxy: 0x4444444444444444444444444444444444444444",
    "+ Factory quote token: 0x5555555555555555555555555555555555555555",
    "+ Creator: 0x6666666666666666666666666666666666666666",
    "+ Factory owner wallet: 0x7777777777777777777777777777777777777777",
    "+ Token sale: 0x8888888888888888888888888888888888888888",
  ].join("\n")), [
    "0x1111111111111111111111111111111111111111",
    "0x4444444444444444444444444444444444444444",
    "0x8888888888888888888888888888888888888888",
  ]);
});

test("unverified Pons repositories stay on the normal polling cadence as intelligence candidates", () => {
  assert.equal(isUnverifiedPonsRepository("ponsdotdev/ponsfamily"), true);
  assert.equal(isUnverifiedPonsRepository("PonsDotFamily/PonsDotFamily"), true);
  assert.equal(isUnverifiedPonsRepository("another/project"), false);
  const candidates = DEFAULT_REPOSITORIES.filter(({ repository }) => isUnverifiedPonsRepository(repository));
  assert.equal(candidates.length, 2);
  for (const candidate of candidates) {
    assert.equal(candidate.sourceTrust, "unverified_candidate");
    assert.equal(candidate.baselineOnly, true);
    assert.equal(PRIORITY_REPOSITORIES.has(candidate.repository.toLowerCase()), false);
  }
});

test("an official Pons backlink upgrades a candidate repository exactly once", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pons-verify-"));
  const alerts = [];
  const repository = "ponsdotdev/ponsfamily";
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  const monitor = createGithubMonitor({ dataDir }, {
    autoStart: false,
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date("2026-08-01T01:00:00Z"),
  });
  const evidence = { source: "official_x", url: "https://x.com/ponsdotfamily/status/123" };
  await monitor.confirmOfficialRepository(repository, evidence);
  await monitor.confirmOfficialRepository(repository, evidence);
  assert.equal(alerts.filter((event) => event.type === "github_repository_verified").length, 1);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._repositories[repository].sourceTrust, "official_verified");
  assert.equal(PRIORITY_REPOSITORIES.has(repository), true);
});

test("an official backlink can verify a newly discovered BSC launchpad repository", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-bsc-verify-"));
  const alerts = [];
  const repository = "bltx-labs/contracts";
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  const monitor = createGithubMonitor({ dataDir }, {
    autoStart: false,
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date("2026-08-02T00:00:00Z"),
  });
  await monitor.confirmOfficialRepository(repository, {
    source: "official_site",
    url: "https://bltx.fun/docs",
    launchpad: "bltx",
    launchpadName: "BLTX.FUN",
  });
  const verified = alerts.find((event) => event.type === "github_repository_verified");
  assert.equal(verified.launchpad, "bltx");
  assert.equal(verified.launchpadName, "BLTX.FUN");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._repositories[repository].launchpad, "bltx");
  assert.equal(state._repositories[repository].sourceTrust, "official_verified");
});

test("a stale site recovery can verify a repository without emitting a fresh discovery alert", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-silent-site-recovery-"));
  const alerts = [];
  const repository = "silent/recovery";
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  const monitor = createGithubMonitor({ dataDir }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
  });
  await monitor.confirmOfficialRepository(repository, {
    source: "official_site",
    url: "https://silent.example",
    launchpad: "silent",
    suppressAlert: true,
  });
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._repositories[repository].sourceTrust, "official_verified");
  assert.equal(alerts.length, 0);
});

test("an unverified Pons repository starts from a silent baseline then emits only new code", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pons-baseline-"));
  const alerts = [];
  let latest = "abcdef10";
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(".atom")) {
      const older = latest === "abcdef11" ? `<entry><id>tag:github.com,2008:Grit::Commit/abcdef10</id><updated>2026-08-01T00:00:00Z</updated><title>old v2 code</title></entry>` : "";
      return { ok: true, status: 200, text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/${latest}</id><updated>2026-08-01T01:00:00Z</updated><title>add v2 factory</title></entry>${older}</feed>` };
    }
    return { ok: true, status: 200, text: async () => "diff --git a/contracts/v2/Factory.sol b/contracts/v2/Factory.sol\nnew file mode 100644\n+++ b/contracts/v2/Factory.sol\n+ contract Factory {}" };
  });
  const repository = DEFAULT_REPOSITORIES.find(({ repository: item }) => item === "ponsdotdev/ponsfamily");
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [repository],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date("2026-08-01T02:00:00Z"),
  });
  await monitor.check(false);
  assert.equal(alerts.length, 0);
  latest = "abcdef11";
  await monitor.check(false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "github_module_update");
  assert.equal(alerts[0].sourceTrust, "unverified_candidate");
  assert.equal(alerts[0].diffStatsAvailable, false);
  assert.equal(alerts[0].committedAt, "2026-08-01T01:00:00Z");
});

test("parses the no-key GitHub Atom fallback", () => {
  const xml = `<feed><entry><id>tag:github.com,2008:Grit::Commit/12:abcdef1234</id><link href="https://github.com/org/repo/commit/abcdef1234"/><title>add new vault</title><author><name>dev</name></author></entry></feed>`;
  assert.deepEqual(parseGithubAtom(xml)[0], {
    sha: "abcdef1234",
    html_url: "https://github.com/org/repo/commit/abcdef1234",
    commit: { message: "add new vault", author: { name: "dev", date: null }, committer: { date: null } },
    atomFallback: true,
  });
});

test("parses the current GitHub Atom commit id format", () => {
  const xml = `<entry><id>tag:github.com,2008:Grit::Commit/abcdef5678</id><updated>2026-08-06T01:02:03Z</updated><link href="https://github.com/org/repo/commit/abcdef5678"/><title>upgrade V2</title></entry>`;
  const commit = parseGithubAtom(xml)[0];
  assert.equal(commit.sha, "abcdef5678");
  assert.equal(commit.commit.author.date, "2026-08-06T01:02:03Z");
  assert.equal(commit.commit.committer.date, "2026-08-06T01:02:03Z");
});

test("public GitHub monitoring falls back from main to master", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-master-fallback-"));
  const requested = [];
  t.after(() => {
    PRIORITY_REPOSITORIES.delete("example/legacy");
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    if (String(url).endsWith("/commits/main.atom")) return { ok: false, status: 404, text: async () => "" };
    if (String(url).endsWith("/commits/master.atom")) return { ok: true, status: 200, text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/abcdef12</id><title>baseline</title></entry></feed>` };
    throw new Error(`unexpected request ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository: "example/legacy", launchpad: "test", priority: true, baselineOnly: true }],
    sendAlertsImpl: async () => {},
  });
  PRIORITY_REPOSITORIES.add("example/legacy");
  await monitor.check(true);
  assert.equal(requested.some((url) => url.endsWith("/commits/master.atom")), true);
});

test("public GitHub Atom polling persists ETag and treats 304 as a cursor-safe no-op", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-atom-etag-"));
  const repository = "example/etag";
  const validators = [];
  let current = new Date("2026-08-12T00:00:00.000Z");
  let atomRequests = 0;
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    assert.equal(String(url).endsWith("/commits/main.atom"), true);
    atomRequests += 1;
    validators.push(options.headers?.["if-none-match"] || null);
    if (atomRequests === 2) {
      return {
        ok: false,
        status: 304,
        headers: new Headers({ etag: '"feed-v1"' }),
        text: async () => { throw new Error("a 304 response body must not be read"); },
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"feed-v1"' }),
      text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/aaaa0001</id><updated>2026-08-12T00:00:00Z</updated><title>baseline</title></entry></feed>`,
    };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "test", priority: true, baselineOnly: true }],
    sendAlertsImpl: async () => { throw new Error("304 must not alert"); },
    now: () => new Date(current),
  });

  await monitor.check(true);
  current = new Date("2026-08-12T00:00:10.000Z");
  await monitor.check(true);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.deepEqual(validators, [null, '"feed-v1"']);
  assert.equal(state[repository].sha, "aaaa0001");
  assert.equal(state._health.repositories[repository].atomBranch, "main");
  assert.equal(state._health.repositories[repository].atomEtag, '"feed-v1"');
  assert.equal(state._health.repositories[repository].lastAtomNotModifiedAt, "2026-08-12T00:00:10.000Z");
});

test("an Atom 503 immediately falls back to the conditional commits API without moving delivery semantics", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-atom-rest-fallback-"));
  const repository = "example/atom-rest-fallback";
  const alerts = [];
  const apiValidators = [];
  const atomValidators = [];
  let current = new Date("2026-08-12T00:10:00.000Z");
  let apiReads = 0;
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: "aaaa0001", checkedAt: "2026-08-12T00:09:00.000Z" },
    _health: {
      repositories: {
        [repository]: {
          status: "healthy",
          atomBranch: "main",
          atomEtag: '"atom-old"',
          commitApiEtag: '"api-old"',
          consecutiveFailures: 0,
        },
      },
    },
  }));
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "github.com" && parsed.pathname.endsWith("/commits/main.atom")) {
      atomValidators.push(options.headers?.["if-none-match"] || null);
      return { ok: false, status: 503, headers: new Headers(), text: async () => "" };
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname === `/repos/${repository}/commits` && parsed.searchParams.has("per_page")) {
      assert.equal(options.headers?.authorization, undefined);
      assert.equal(options.signal instanceof AbortSignal, true);
      apiValidators.push(options.headers?.["if-none-match"] || null);
      apiReads += 1;
      if (apiReads === 2) {
        return {
          ok: false,
          status: 304,
          headers: new Headers({ etag: '"api-new"' }),
          json: async () => { throw new Error("a 304 response body must not be read"); },
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ etag: '"api-new"' }),
        json: async () => [
          {
            sha: "bbbb0002",
            html_url: `https://github.com/${repository}/commit/bbbb0002`,
            commit: {
              message: "feat: add v2 launch module",
              author: { name: "dev", date: "2026-08-12T00:10:00.000Z" },
              committer: { date: "2026-08-12T00:10:00.000Z" },
            },
          },
          {
            sha: "aaaa0001",
            commit: {
              message: "previous",
              author: { name: "dev", date: "2026-08-12T00:09:00.000Z" },
              committer: { date: "2026-08-12T00:09:00.000Z" },
            },
          },
        ],
      };
    }
    if (parsed.hostname === "github.com" && parsed.pathname === `/${repository}/commit/bbbb0002.patch`) {
      return {
        ok: true,
        status: 200,
        text: async () => "diff --git a/contracts/V2.sol b/contracts/V2.sol\nnew file mode 100644\n--- /dev/null\n+++ b/contracts/V2.sol\n+contract V2 {}",
      };
    }
    throw new Error(`unexpected request ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "test", priority: true, sourceTrust: "official_verified" }],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date(current),
  });

  await monitor.check(true);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, "bbbb0002");
  assert.deepEqual(alerts.map(({ commit }) => commit), ["bbbb0002"]);
  assert.equal(alerts[0].diffStatsAvailable, false, "REST list fallback must retain public-feed event semantics");
  assert.equal(state._health.repositories[repository].atomEtag, '"atom-old"');
  assert.equal(state._health.repositories[repository].commitApiEtag, '"api-new"');
  assert.equal(state._health.repositories[repository].lastCommitSource, "rest_api_fallback");
  assert.equal(state._health.repositories[repository].lastAtomRestFallbackReason, "atom_http_503");

  current = new Date("2026-08-12T00:10:10.000Z");
  await monitor.check(true);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.deepEqual(atomValidators, ['"atom-old"', '"atom-old"']);
  assert.deepEqual(apiValidators, ['"api-old"', '"api-new"']);
  assert.equal(state._health.repositories[repository].lastCommitApiNotModifiedAt, "2026-08-12T00:10:10.000Z");
  assert.equal(alerts.length, 1, "the API fallback must retain the existing commit cursor deduplication");
});

test("an Atom transport failure falls back to REST in the same poll", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-atom-transport-fallback-"));
  const repository = "example/transport-fallback";
  const requested = [];
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    requested.push(parsed.hostname);
    if (parsed.hostname === "github.com") throw new TypeError("fetch failed");
    if (parsed.hostname === "api.github.com" && parsed.pathname === `/repos/${repository}/commits`) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ etag: '"api-baseline"' }),
        json: async () => [{
          sha: "aaaa0001",
          commit: { message: "baseline", author: { date: "2026-08-12T00:20:00.000Z" }, committer: { date: "2026-08-12T00:20:00.000Z" } },
        }],
      };
    }
    throw new Error(`unexpected request ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "test", priority: true, baselineOnly: true }],
    sendAlertsImpl: async () => { throw new Error("baseline must not alert"); },
    now: () => new Date("2026-08-12T00:20:00.000Z"),
  });

  await monitor.check(true);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.deepEqual(requested, ["github.com", "api.github.com"]);
  assert.equal(state[repository].sha, "aaaa0001");
  assert.equal(state._health.repositories[repository].status, "healthy");
  assert.equal(state._health.repositories[repository].lastAtomRestFallbackReason, "atom_transport_failure");
});

test("an unauthenticated REST rate limit opens a shared circuit while public Atom polling continues", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-rest-circuit-"));
  const repositories = ["example/rate-limited-one", "example/rate-limited-two"];
  const atomRequests = [];
  const apiRequests = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "github.com" && parsed.pathname.endsWith("/commits/main.atom")) {
      atomRequests.push(parsed.pathname);
      return { ok: false, status: 503, headers: new Headers(), text: async () => "" };
    }
    if (parsed.hostname === "api.github.com") {
      apiRequests.push(parsed.pathname);
      return { ok: false, status: 403, headers: new Headers(), json: async () => ({ message: "rate limited" }) };
    }
    throw new Error(`unexpected request ${url}`);
  });
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    githubPollConcurrency: 1,
    githubRetryBaseMs: 1_000,
    githubRetryMaxMs: 8_000,
  }, {
    autoStart: false,
    repositories: repositories.map((repository) => ({ repository, launchpad: "test", baselineOnly: true })),
    sendAlertsImpl: async () => {},
    now: () => new Date("2026-08-12T00:25:00.000Z"),
    random: () => 0.5,
  });

  await monitor.check(false);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(atomRequests.length, 2, "the circuit must not suppress public Atom reads");
  assert.deepEqual(apiRequests, ["/repos/example/rate-limited-one/commits"]);
  assert.match(state._health.repositories[repositories[1]].lastError, /REST circuit is open/);
  assert.ok(state._health.repositories[repositories[0]].backoffMs >= 59 * 60_000);
  assert.ok(state._health.repositories[repositories[1]].backoffMs >= 59 * 60_000);
});

test("the REST commit path keeps token, ETag, and rate-limit retry metadata", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-rest-validator-rate-limit-"));
  const repository = "example/rest-rate-limit";
  let atomRequests = 0;
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: "aaaa0001", checkedAt: "2026-08-12T00:29:00.000Z" },
    _health: { repositories: { [repository]: { commitApiEtag: '"api-old"', consecutiveFailures: 0 } } },
  }));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com") {
      assert.equal(options.headers?.authorization, "Bearer test-token");
      assert.equal(options.headers?.["if-none-match"], '"api-old"');
      return { ok: false, status: 429, headers: new Headers({ "retry-after": "120" }) };
    }
    if (parsed.hostname === "github.com") {
      atomRequests += 1;
      return { ok: false, status: 503, headers: new Headers(), text: async () => "" };
    }
    throw new Error(`unexpected request ${url}`);
  });
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "test-token",
    githubRetryBaseMs: 1_000,
    githubRetryMaxMs: 8_000,
  }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "test", priority: true }],
    sendAlertsImpl: async () => {},
    now: () => new Date("2026-08-12T00:30:00.000Z"),
    random: () => 0.5,
  });

  await monitor.check(true);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, "aaaa0001");
  assert.equal(state._health.repositories[repository].status, "degraded");
  assert.equal(state._health.repositories[repository].lastErrorStatus, 429);
  assert.equal(state._health.repositories[repository].nextAttemptAt, "2026-08-12T00:32:00.000Z");
  assert.equal(atomRequests, 0, "a rate-limited authenticated endpoint must not be bypassed through Atom");
});

test("a failed commit does not promote the new Atom ETag before a safe retry", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-atom-etag-durability-"));
  const repository = "example/etag-durability";
  const validators = [];
  let current = new Date("2026-08-12T01:00:00.000Z");
  let deliveryAttempts = 0;
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: "aaaa0001", checkedAt: "2026-08-12T00:59:00.000Z" },
    _health: {
      repositories: {
        [repository]: {
          status: "healthy",
          atomBranch: "main",
          atomEtag: '"feed-old"',
          consecutiveFailures: 0,
        },
      },
    },
  }));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (String(url).endsWith(".atom")) {
      validators.push(options.headers?.["if-none-match"] || null);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ etag: '"feed-new"' }),
        text: async () => `<feed>
          <entry><id>tag:github.com,2008:Grit::Commit/bbbb0002</id><updated>2026-08-12T01:00:00Z</updated><title>add V2 launch module</title></entry>
          <entry><id>tag:github.com,2008:Grit::Commit/aaaa0001</id><updated>2026-08-12T00:59:00Z</updated><title>old</title></entry>
        </feed>`,
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "diff --git a/contracts/V2.sol b/contracts/V2.sol\nnew file mode 100644\n+++ b/contracts/V2.sol\n+ contract V2 {}",
    };
  });
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    githubRetryBaseMs: 1_000,
    githubRetryMaxMs: 8_000,
  }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "test", priority: true, sourceTrust: "official_verified" }],
    sendAlertsImpl: async () => {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) throw new Error("delivery unavailable");
    },
    now: () => new Date(current),
    random: () => 0.5,
  });

  await monitor.check(true);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, "aaaa0001");
  assert.equal(state._health.repositories[repository].atomEtag, '"feed-old"');

  current = new Date("2026-08-12T01:00:01.000Z");
  await monitor.check(true);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.deepEqual(validators, ['"feed-old"', '"feed-old"']);
  assert.equal(state[repository].sha, "bbbb0002");
  assert.equal(state._health.repositories[repository].atomEtag, '"feed-new"');
  assert.equal(deliveryAttempts, 2);
});

test("parses added contract files from GitHub patches", () => {
  const patch = `diff --git a/src/Old.sol b/src/Old.sol\nindex 1..2 100644\n--- a/src/Old.sol\n+++ b/src/Old.sol\ndiff --git a/src/NewVault.sol b/src/NewVault.sol\nnew file mode 100644\n--- /dev/null\n+++ b/src/NewVault.sol`;
  assert.deepEqual(parseGithubPatchFiles(patch).map(({ filename, status }) => ({ filename, status })), [{ filename: "src/Old.sol", status: "modified" }, { filename: "src/NewVault.sol", status: "added" }]);
});

test("extracts bounded structural before-to-after facts without retaining arbitrary patch text", () => {
  const evidence = extractGithubChangeEvidence([{
    filename: "config/vault.ts",
    patch: [
      '-vaultMode: "v2",',
      '+vaultMode: "v3",',
      '+quoteTokenSupport: true,',
      '+apiSecret: "must-not-leak",',
      '+export function isQuoteTokenSupported() {',
      '+  return true;',
    ].join("\n"),
  }]);

  assert.deepEqual(evidence, [
    { file: "config/vault.ts", kind: "config_value", subject: "vaultMode", before: "v2", after: "v3" },
    { file: "config/vault.ts", kind: "config_value", subject: "quoteTokenSupport", before: null, after: "true" },
    { file: "config/vault.ts", kind: "function", subject: "isQuoteTokenSupported", action: "added" },
  ]);
  assert.doesNotMatch(JSON.stringify(evidence), /must-not-leak|apiSecret/);
});

test("summarizes the real X docs 471b route delta and never treats documentation prose as a code declaration", () => {
  const files = parseGithubPatchFiles(`diff --git a/docs.json b/docs.json
index 1111111..471b000 100644
--- a/docs.json
+++ b/docs.json
@@ -88,6 +88,7 @@
       "x-api/chat/send-chat-message",
+      "x-api/chat/delete-chat-messages",
       "x-api/chat/send-typing-indicator",
diff --git a/docs/reference.md b/docs/reference.md
index 2222222..3333333 100644
--- a/docs/reference.md
+++ b/docs/reference.md
@@ -4,0 +5,1 @@
+Contract Address: documentation label only`);
  const githubChange = summarizeGithubChange(files, {
    repository: "xdevplatform/docs",
    commitMessage: "Add delete chat messages to the API side navigation",
    stage: "commit",
    basis: "exact_patch",
  });

  assert.equal(githubChange.scheme, "github_change_v1");
  assert.equal(githubChange.completeness, "complete");
  assert.equal(githubChange.classification, "documentation");
  assert.deepEqual(githubChange.primaryFact, {
    file: "docs.json",
    kind: "list_item",
    subject: "docs.json",
    after: "x-api/chat/delete-chat-messages",
    action: "added",
  });
  assert.equal(githubChange.facts.some((fact) => fact.kind === "contract"), false);
  assert.match(githubChange.summary, /delete-chat-messages/);
});

test("summarizes both real Flap PR 10 revisions without inventing a deployment or declaration", () => {
  const first = summarizeGithubChange([{
    filename: "src/FreeCoinBeacon.sol",
    status: "modified",
    patch: "+ beacon = address (0xbf5a9cb152cb11a4a7af05602b7684219ec6bdbab9e4201d07ddc41de8d97996);",
  }], {
    repository: "flap-sh/FlapVaultExample",
    commitMessage: "Update FreeCoin beacon reference",
    stage: "pull_request",
  });
  assert.deepEqual(first.primaryFact, {
    file: "src/FreeCoinBeacon.sol",
    kind: "code_assignment",
    subject: "beacon",
    before: null,
    after: "address (0xbf5a9cb1…e8d97996)",
  });

  const revision = summarizeGithubChange([{
    filename: "src/FreeCoinBeacon.sol",
    status: "modified",
    patch: "+ Contract Address : 0x7580476d980d749893e6be419f52616247237777",
  }], {
    repository: "flap-sh/FlapVaultExample",
    commitMessage: "Update FreeCoin beacon reference\nDocument the reviewed contract address",
    stage: "pull_request",
  });
  assert.equal(revision.primaryFact.kind, "code_line");
  assert.match(revision.primaryFact.after, /Contract Address : 0x7580476d980d749893e6be419f52616247237777/);
  assert.equal(revision.facts.some((fact) => fact.kind === "contract"), false);
  assert.doesNotMatch(JSON.stringify(revision.facts), /…/, "valid EVM addresses must remain exact evidence");
  assert.equal(revision.fingerprint === first.fingerprint, false, "a revised PR head must retain a distinct semantic delta");
});

test("prioritizes Binance PR 307-309 skill meaning and the PR 308 direct-execution delta over helper symbols", () => {
  const aiko = summarizeGithubChange([
    {
      filename: "skills/binance-web3/aiko/SKILL.md",
      status: "added",
      patch: "+---\n+name: aiko\n+description: |\n+  Multi-signal decision-fusion engine for a single token: combines trading-signal momentum,\n+  crypto-market-rank flow and query-token-audit risk into one composite decision.\n+version: 0.1.0\n+---\n+# Aiko",
    },
    {
      filename: "skills/binance-web3/aiko/scripts/cli.mjs",
      status: "added",
      patch: "+export function parseSignals() {",
    },
    {
      filename: "skills/binance-web3/aiko/tests/cli.test.mjs",
      status: "added",
      patch: "+test('parses a signal', () => {});",
    },
  ], {
    repository: "binance/binance-skills-hub",
    commitMessage: "Add aiko: multi-signal decision-fusion skill",
    stage: "pull_request",
  });
  assert.equal(aiko.primaryFact.subject, "skill:aiko");
  assert.match(aiko.primaryFact.after, /Multi-signal decision-fusion/i);
  assert.equal(aiko.substantive, true);

  const windows = summarizeGithubChange([{
    filename: "skills/binance-web3/common/scripts/cli.mjs",
    status: "modified",
    patch: [
      "-if (import.meta.url === `file://${process.argv[1]}`) main();",
      "+export function isDirectExecution() {",
      "+  if (!process.argv[1]) return false;",
      "+  return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);",
      "+}",
      "+if (isDirectExecution()) main();",
    ].join("\n"),
  }], {
    repository: "binance/binance-skills-hub",
    commitMessage: "Fix CLI scripts producing no output on Windows",
    stage: "pull_request",
  });
  assert.equal(windows.primaryFact.kind, "code_line");
  assert.match(windows.primaryFact.before, /import\.meta\.url/);
  assert.match(windows.primaryFact.after, /isDirectExecution/);
  assert.match(windows.primaryFact.after, /realpathSync/);
  assert.match(windows.primaryFact.after, /fileURLToPath/);
  assert.equal(isSemanticallyRelevantBinanceChange("binance/binance-skills-hub", {
    commit: { message: "Fix CLI scripts silently producing no output on Windows" },
  }, [{
    filename: "skills/binance-web3/common/scripts/cli.mjs",
    status: "modified",
    patch: "-if (import.meta.url === `file://${process.argv[1]}`) {\n+if (isDirectExecution()) {",
  }]), true);

  const actionReference = summarizeGithubChange([{
    filename: "skills/binance-web3/onchain-pay-action-ref-verify/SKILL.md",
    status: "added",
    patch: "+---\n+name: onchain-pay-action-ref-verify\n+description: |\n+  Derives and independently verifies action_ref, a deterministic content-addressed identifier,\n+  and checks it against an on-chain anchor if one exists. Read-only.\n+metadata:\n+  version: 0.1.0\n+---",
  }], {
    repository: "binance/binance-skills-hub",
    commitMessage: "Add onchain-pay-action-ref-verify skill",
    stage: "pull_request",
  });
  assert.equal(actionReference.primaryFact.subject, "skill:onchain-pay-action-ref-verify");
  assert.match(actionReference.primaryFact.after, /Derives and independently verifies action_ref/);
  assert.match(actionReference.primaryFact.after, /on-chain anchor/);
});

test("prioritizes production API facts over test snapshots for representative Uniswap PR 243 and 245 diffs", () => {
  const guardian = summarizeGithubChange([
    { filename: "script/contracts/periphery/DeployFullRangeGuardian.s.sol", status: "added", patch: "+contract DeployFullRangeGuardianScript is Script {\n+function run() external {}\n+}" },
    { filename: "test/FullRangeGuardian.t.sol", status: "added", patch: "+contract FullRangeGuardianTest {}" },
    { filename: "src/periphery/FullRangeGuardian.sol", status: "added", patch: "+interface ICompoundingRecipient {\n+function claim(uint256 tokenId) external;\n+}\n+contract FullRangeGuardian is IClaimExecutor {" },
  ], {
    repository: "Uniswap/liquidity-launcher",
    commitMessage: "feat: add FullRangeGuardian periphery contract",
    stage: "pull_request",
  });
  assert.deepEqual(guardian.primaryFact, {
    file: "src/periphery/FullRangeGuardian.sol",
    kind: "contract",
    subject: "FullRangeGuardian",
    action: "added",
  });

  const feeUpdate = summarizeGithubChange([
    { filename: "snapshots/state.json", status: "modified", patch: '-"fee": 100,\n+"fee": 200,' },
    { filename: "src/interfaces/external/IV4FeeAdapter.sol", status: "added", patch: "+interface IV4FeeAdapter {\n+function triggerFeeUpdate() external;\n+}" },
    { filename: "src/strategies/InstantLaunchStrategy.sol", status: "modified", patch: "-feeAdapter.update();\n+feeAdapter.triggerFeeUpdate();" },
  ], {
    repository: "Uniswap/liquidity-launcher",
    commitMessage: "feat: add fee update call",
    stage: "pull_request",
  });
  assert.equal(feeUpdate.primaryFact.file, "src/interfaces/external/IV4FeeAdapter.sol");
  assert.equal(feeUpdate.primaryFact.kind, "function");
  assert.equal(feeUpdate.primaryFact.subject, "triggerFeeUpdate");
  assert.equal(feeUpdate.facts.some((fact) => /snapshot/i.test(fact.file) && fact === feeUpdate.primaryFact), false);
});

test("marks missing or truncated GitHub patches honestly instead of claiming a complete semantic diff", () => {
  const partial = summarizeGithubChange([
    { filename: "src/live.ts", status: "modified", patch: "+export const launchMode = 'v3';" },
    { filename: "src/large.ts", status: "modified", patch: "", patchComplete: false },
  ], { repository: "example/platform", stage: "pull_request", basis: "pull_request_snapshot" });
  assert.equal(partial.completeness, "partial");
  assert.equal(partial.fallbackReason, "one_or_more_patches_missing_or_truncated");

  const metadataOnly = summarizeGithubChange([
    { filename: "src/binary.wasm", status: "modified" },
  ], { repository: "example/platform", stage: "commit", basis: "api_patch" });
  assert.equal(metadataOnly.completeness, "metadata_only");
  assert.equal(metadataOnly.primaryFact.kind, "file_change");
  assert.equal(metadataOnly.primaryFact.confidence, "metadata_only");
});

test("classifies the official Flap skill Tax V3 and quote-token capability delta from the real patch", async () => {
  const repository = "flap-sh/flap-skills";
  const patch = await githubFixture("flap-skills-dbcdda.patch");
  const files = parseGithubPatchFiles(patch);
  const change = classifyFlapSkillChange(repository, parseGithubPatchMessage(patch), files);

  assert.equal(change.scheme, "flap_skill_change_v1");
  assert.equal(change.candidate, true);
  assert.equal(change.classification, "skill_capability_change");
  assert.equal(change.documentationOnly, false);
  assert.deepEqual(change.labels, [
    "Tax Token V3 only",
    "configurable quote tokens",
    "ERC-20 quote approval flow",
  ]);
  assert.deepEqual(change.identifiers, [
    "TOKEN_TAXED_V3",
    "GET /api/launch/quote-tokens",
    "chainId=56",
  ]);
  assert.match(change.fingerprint, /^[a-f0-9]{24}$/);
  assert.deepEqual(change.facts.map(({ kind, subject, before, after }) => ({ kind, subject, before, after })), [
    { kind: "config_value", subject: "launch token type", before: "TOKEN_V2_PERMIT or TOKEN_TAXED_V3", after: "TOKEN_TAXED_V3 only" },
    { kind: "api_call_signature", subject: "GET /api/launch/quote-tokens", before: null, after: "chainId=56 quoteToken + decimals" },
    { kind: "code_assignment", subject: "transaction value", before: "native BNB quoteAmt as msg.value", after: "native quoteAmt; ERC-20 msg.value=0 after approve" },
  ]);
  assert.equal(isRelevantRepositoryFile(repository, "launch-bnb-token-on-flap/references/quote-tokens.md"), true);
  assert.equal(GITHUB_PULL_REQUEST_TARGETS.some((item) => item.toLowerCase() === repository), true);

  const docsOnly = classifyFlapSkillChange(repository, "docs: explain local install", [{
    filename: "README.md",
    status: "modified",
    patch: "+No functional or skill-content changes.",
  }]);
  assert.equal(docsOnly.candidate, false);
  assert.equal(docsOnly.documentationOnly, true);
  assert.equal(docsOnly.classification, "documentation_or_non_structural");
});

test("the public Atom producer routes the official Flap skill structural commit in focus3", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-flap-skill-dbcdda-"));
  const repository = "flap-sh/flap-skills";
  const commit = "dbcdda580317ae0f01b8883093a536c6725086ce";
  const featureCommit = "f74e1095c988b26aaac9f97dd8d58bde3c2ce04c";
  const anchor = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const patch = await githubFixture("flap-skills-dbcdda.patch");
  const alerts = [];
  const producerEvents = [];
  const acceptedKeys = new Set();
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({ [repository]: { sha: anchor } }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const value = String(url);
    if (value.endsWith(".atom")) return {
      ok: true,
      status: 200,
      text: async () => `<feed>
        <entry><id>tag:github.com,2008:Grit::Commit/${commit}</id><updated>2026-08-21T18:22:14Z</updated><link href="https://github.com/${repository}/commit/${commit}"/><title>Merge pull request #1 from flap-sh/tax-v3-quote-tokens</title><author><name>flapguy</name></author></entry>
        <entry><id>tag:github.com,2008:Grit::Commit/${featureCommit}</id><updated>2026-08-21T18:19:19Z</updated><link href="https://github.com/${repository}/commit/${featureCommit}"/><title>feat(launch-bnb-token-on-flap): tax-only tokens + configurable quote tokens</title><author><name>flapguy</name></author></entry>
        <entry><id>tag:github.com,2008:Grit::Commit/${anchor}</id><updated>2026-08-21T18:00:00Z</updated><link href="https://github.com/${repository}/commit/${anchor}"/><title>anchor</title></entry>
      </feed>`,
    };
    if (value.endsWith(`/commit/${commit}.patch`) || value.endsWith(`/commit/${featureCommit}.patch`)) return { ok: true, status: 200, text: async () => patch };
    throw new Error(`unexpected GitHub request: ${url}`);
  });

  const config = { dataDir, githubToken: "", monitorScope: "focus3" };
  const monitor = createGithubMonitor(config, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified", priority: true }],
    sendAlertsImpl: async (_config, event) => {
      producerEvents.push(event);
      if (acceptedKeys.has(event.eventKey)) return { status: "duplicate" };
      acceptedKeys.add(event.eventKey);
      alerts.push(event);
      return { status: "queued" };
    },
    now: () => new Date("2026-08-21T18:22:20Z"),
  });
  await monitor.check(true);

  assert.equal(alerts.length, 1);
  assert.equal(producerEvents.length, 2, "both the feature commit and merge wrapper are evaluated");
  assert.equal(new Set(producerEvents.map(({ eventKey }) => eventKey)).size, 1, "the merge wrapper reuses the first capability key");
  const event = alerts[0];
  assert.equal(event.commit, featureCommit, "the first functional commit wins semantic dedup");
  assert.equal(event.strong, true);
  assert.equal(event.sourceTrust, "official_verified");
  assert.equal(event.modeChange.candidate, true);
  assert.equal(event.modeChange.reason, "flap_agentic_skill_capability_change");
  assert.equal(event.flapSkillChange.scheme, "flap_skill_change_v1");
  assert.equal(event.eventKey, `github:${repository}:flap-skill:${event.flapSkillChange.fingerprint}`);
  assert.equal(event.githubChange.classification, "substantive");
  assert.deepEqual(event.githubChange.primaryFact, event.flapSkillChange.facts[0]);
  assert.deepEqual(event.changeEvidence.slice(0, 3), event.flapSkillChange.facts);
  assert.equal(isMonitoringSourceEnabled(config, event), true);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, commit);
});

test("the Flap skills pull-request lane records README-only PR 2 as non-actionable", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-flap-skill-doc-pr-"));
  const repository = "flap-sh/flap-skills";
  const alerts = [];
  let currentTime = new Date("2026-08-22T12:00:00Z");
  let includePr2 = false;
  const existing = {
    number: 1,
    title: "feat: configurable quote tokens",
    body: "",
    state: "open",
    draft: false,
    html_url: `https://github.com/${repository}/pull/1`,
    created_at: "2026-08-21T10:00:00Z",
    updated_at: "2026-08-21T10:00:00Z",
    head: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    user: { login: "flapguy" },
    author_association: "MEMBER",
  };
  const docs = {
    number: 2,
    title: "docs: explain how to install the skill",
    body: "Documentation-only. No functional or skill-content changes.",
    state: "open",
    draft: false,
    html_url: `https://github.com/${repository}/pull/2`,
    created_at: "2026-08-22T12:09:00Z",
    updated_at: "2026-08-22T12:10:00Z",
    head: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    user: { login: "contributor" },
    author_association: "CONTRIBUTOR",
  };
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/repos/${repository}/pulls`) return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => includePr2 ? [docs, existing] : [existing],
    };
    if (parsed.pathname === `/repos/${repository}/pulls/2/files`) return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => [{ filename: "README.md", status: "modified", additions: 5, deletions: 1, patch: "+No functional or skill-content changes." }],
    };
    throw new Error(`unexpected GitHub PR request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubPrPollIntervalMs: 1_000 }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified", priority: true }],
    pullRequestRepositories: [repository],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date(currentTime),
  });

  await monitor.checkPullRequests();
  includePr2 = true;
  currentTime = new Date("2026-08-22T12:10:00Z");
  await monitor.checkPullRequests();

  assert.equal(alerts.length, 0);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._pullRequests.repositories[repository].pullRequests["2"].actionable, false);
});

test("extracts Binance connector dependency, call-signature, and response-schema facts from real patches", async () => {
  const repository = "binance/binance-connector-go";
  const cases = [
    {
      fixture: "binance-wallet-665ca7fd.patch",
      classification: "sdk_maintenance",
      expected: { kind: "dependency_version", subject: "github.com/binance/binance-connector-go/common/v2", before: "v2.6.0", after: "v2.7.0" },
    },
    {
      fixture: "binance-alpha-3744783d.patch",
      classification: "api_or_schema_change",
      expected: { kind: "api_call_signature", subject: "Connect", before: "Connect()", after: "Connect([]string{})" },
    },
    {
      fixture: "binance-subaccount-0efaaa29.patch",
      classification: "api_or_schema_change",
      expected: { kind: "response_schema", subject: "querySubAccountApiKey() response", before: "list", after: "rows" },
    },
    {
      fixture: "binance-mining-1b4d14ea.patch",
      classification: "sdk_maintenance",
      expected: { kind: "dependency_version", subject: "github.com/binance/binance-connector-go/common/v2", before: null, after: "v2.7.0" },
    },
  ];

  for (const item of cases) {
    const patch = await githubFixture(item.fixture);
    const files = parseGithubPatchFiles(patch);
    const message = parseGithubPatchMessage(patch);
    const evidence = extractGithubChangeEvidence(files, 4, { repository, commitMessage: message });
    const classified = classifyBinanceGithubChange(repository, message, files, evidence);
    assert.deepEqual(evidence.find((entry) => entry.kind === item.expected.kind), {
      file: evidence.find((entry) => entry.kind === item.expected.kind)?.file,
      ...item.expected,
      ...(item.expected.kind === "response_schema" ? { endpoint: "GET /sapi/v1/sub-account/subAccountApi" } : {}),
    }, item.fixture);
    assert.equal(classified.classification, item.classification, item.fixture);
    assert.equal(classified.substantive, item.classification === "api_or_schema_change", item.fixture);
    assert.equal(classified.productFeature, false, item.fixture);
    assert.equal(isSemanticallyRelevantBinanceChange(repository, { commit: { message }, patchMessage: message }, files), true, item.fixture);
  }

  assert.equal(isRelevantRepositoryFile(repository, "clients/wallet/go.mod"), true);
  const walletPatch = await githubFixture("binance-wallet-665ca7fd.patch");
  const walletFiles = parseGithubPatchFiles(walletPatch);
  assert.deepEqual(
    extractBinanceConnectorChangeEvidence(walletFiles, parseGithubPatchMessage(walletPatch))[0],
    {
      file: "clients/wallet/go.mod",
      kind: "dependency_version",
      subject: "github.com/binance/binance-connector-go/common/v2",
      before: "v2.6.0",
      after: "v2.7.0",
    },
  );
});

test("the public Atom producer emits Binance maintenance normally and makes only substantive connector diffs strong", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-binance-connector-diff-"));
  const repository = "binance/binance-connector-go";
  const anchor = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const revisions = [
    ["3744783d9cb92a6de8a19b5d4ed06fc7dd5b98a2", "Release alpha v1.7.0", "binance-alpha-3744783d.patch"],
    ["0efaaa297cd54be4e619049288aee63cde0c9270", "Release subaccount v1.11.0", "binance-subaccount-0efaaa29.patch"],
    ["665ca7fdf188983d67c855cb9b03dbc40b92f432", "Release wallet v1.13.0", "binance-wallet-665ca7fd.patch"],
    ["1b4d14eadc66e841a03f16b7eed1e51f32e710df", "Release mining v1.9.0", "binance-mining-1b4d14ea.patch"],
  ];
  const patches = new Map(await Promise.all(revisions.map(async ([sha, , fixture]) => [sha, await githubFixture(fixture)])));
  const alerts = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({ [repository]: { sha: anchor } }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const value = String(url);
    if (value.endsWith(".atom")) {
      const entries = [...revisions].reverse().map(([sha, title], index) => `<entry><id>tag:github.com,2008:Grit::Commit/${sha}</id><updated>2026-08-19T13:0${index}:00Z</updated><link href="https://github.com/${repository}/commit/${sha}"/><title>${title}</title></entry>`).join("");
      return { ok: true, status: 200, text: async () => `<feed>${entries}<entry><id>tag:github.com,2008:Grit::Commit/${anchor}</id><updated>2026-08-19T12:00:00Z</updated><title>anchor</title></entry></feed>` };
    }
    const sha = value.match(/\/commit\/([a-f0-9]{40})\.patch$/i)?.[1];
    if (sha && patches.has(sha)) return { ok: true, status: 200, text: async () => patches.get(sha) };
    throw new Error(`unexpected request ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Binance", sourceTrust: "official_verified" }],
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      return { status: "queued" };
    },
    now: () => new Date("2026-08-19T13:05:00.000Z"),
  });

  await monitor.check(false);
  assert.equal(alerts.length, 4);
  const byCommit = new Map(alerts.map((event) => [event.commit, event]));
  for (const [sha, , fixture] of revisions) {
    const event = byCommit.get(sha);
    assert.equal(event.binanceOfficial, true, fixture);
    assert.equal(event.binanceChange.scheme, "binance_connector_diff_v1", fixture);
    assert.equal(event.strong, [revisions[0][0], revisions[1][0]].includes(sha), fixture);
  }
  assert.deepEqual(byCommit.get(revisions[0][0]).changeEvidence[0], {
    file: "clients/alpha/src/websocketstreams/docs/DefaultAPI.md",
    kind: "api_call_signature",
    subject: "Connect",
    before: "Connect()",
    after: "Connect([]string{})",
  });
  assert.deepEqual(byCommit.get(revisions[1][0]).changeEvidence[0], {
    file: "clients/subaccount/CHANGELOG.md",
    kind: "response_schema",
    subject: "querySubAccountApiKey() response",
    before: "list",
    after: "rows",
    endpoint: "GET /sapi/v1/sub-account/subAccountApi",
  });
  assert.equal(byCommit.get(revisions[2][0]).binanceChange.classification, "sdk_maintenance");
  assert.equal(byCommit.get(revisions[3][0]).binanceChange.classification, "sdk_maintenance");
});

test("parses only repositories owned by the requested GitHub organization", () => {
  const html = `
    <a href="/flap-sh/flap-skills">skills</a>
    <a href='/flap-sh/FlapVaultExample/stargazers'>vault</a>
    <a href="/someone-else/not-flap">other</a>
  `;
  assert.deepEqual(parseGithubRepositoryPage(html, "flap-sh").map(({ full_name }) => full_name).sort(), ["flap-sh/FlapVaultExample", "flap-sh/flap-skills"].sort());
});

test("monitors verified Four.Meme community sources and labels the unbacklinked account as a candidate", () => {
  const repositories = new Map(DEFAULT_REPOSITORIES.map((entry) => [entry.repository.toLowerCase(), entry]));
  const expected = [
    "four-meme/four-smart-contracts",
    "four-meme-community/openfour-docs",
    "four-meme-community/four-meme-ai",
  ];
  for (const repository of expected) {
    assert.equal(repositories.has(repository), true);
  }
  assert.equal(PRIORITY_REPOSITORIES.has("four-meme/four-smart-contracts"), false);
  assert.equal(PRIORITY_REPOSITORIES.has("four-meme-community/openfour-docs"), true);
  assert.equal(PRIORITY_REPOSITORIES.has("four-meme-community/four-meme-ai"), true);
  assert.equal(repositories.get("four-meme/four-smart-contracts").sourceTrust, "unverified_candidate");
  assert.equal(repositories.get("four-meme/four-smart-contracts").baselineOnly, true);
  assert.equal(repositories.get("four-meme-community/openfour-docs").sourceTrust, "official_verified");
  assert.equal(repositories.get("four-meme-community/four-meme-ai").sourceTrust, "official_verified");
});

test("monitors every current Flap organization repository on the priority loop", () => {
  const repositories = DEFAULT_REPOSITORIES.map(({ repository }) => repository.toLowerCase());
  for (const repository of ["flap-sh/flapvaultexample", "flap-sh/flap-vault-component-template", "flap-sh/flap-skills"]) {
    assert.equal(repositories.includes(repository), true);
    assert.equal(PRIORITY_REPOSITORIES.has(repository), true);
  }
  assert.equal(isRelevantModuleFile("skills/flap/SKILL.md"), true);
});

test("priority polling starts Flap and Four.Meme without waiting for a slow verified Pons repository", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-priority-parallel-"));
  const ponsRepository = "ponsdotdev/ponsfamily";
  let releasePons;
  const slowPons = new Promise((resolve) => { releasePons = resolve; });
  const requested = [];
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(ponsRepository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  PRIORITY_REPOSITORIES.add(ponsRepository);
  t.mock.method(globalThis, "fetch", async (url) => {
    const value = String(url);
    requested.push(value);
    if (value.includes(`/${ponsRepository}/`) && value.endsWith(".atom")) await slowPons;
    return { ok: true, status: 200, text: async () => "<feed></feed>" };
  });
  const repositories = [
    { repository: ponsRepository, launchpad: "pons", priority: true, sourceTrust: "official_verified", baselineOnly: true },
    DEFAULT_REPOSITORIES.find(({ repository }) => repository === "flap-sh/flap-skills"),
    DEFAULT_REPOSITORIES.find(({ repository }) => repository === "four-meme-community/openfour-docs"),
  ];
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories,
    sendAlertsImpl: async () => {},
  });

  const check = monitor.check(true);
  for (let attempt = 0; attempt < 20 && requested.length < repositories.length; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  try {
    assert.equal(requested.some((url) => url.includes("/flap-sh/flap-skills/")), true);
    assert.equal(requested.some((url) => url.includes("/four-meme-community/openfour-docs/")), true);
  } finally {
    releasePons();
  }
  await check;
});

test("overlapping GitHub lane ticks coalesce into one immediate follow-up without same-lane concurrency", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-lane-coalescing-"));
  const priorityRepository = "example/coalesced-priority";
  const regularRepository = "example/coalesced-regular";
  const sha = "aaaa0001";
  const requests = new Map([[priorityRepository, 0], [regularRepository, 0]]);
  const active = new Map([[priorityRepository, 0], [regularRepository, 0]]);
  const maxActive = new Map([[priorityRepository, 0], [regularRepository, 0]]);
  const started = new Map();
  const release = new Map();
  const secondStarted = new Map();
  const releaseSecond = new Map();
  for (const repository of requests.keys()) {
    started.set(repository, new Promise((resolve) => { started.set(`${repository}:resolve`, resolve); }));
    release.set(repository, new Promise((resolve) => { release.set(`${repository}:resolve`, resolve); }));
    secondStarted.set(repository, new Promise((resolve) => { secondStarted.set(`${repository}:resolve`, resolve); }));
    releaseSecond.set(repository, new Promise((resolve) => { releaseSecond.set(`${repository}:resolve`, resolve); }));
  }
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(priorityRepository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [priorityRepository]: { sha },
    [regularRepository]: { sha },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const match = String(url).match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/commits\/main\.atom$/);
    assert.ok(match, `unexpected request ${url}`);
    const repository = match[1];
    requests.set(repository, requests.get(repository) + 1);
    active.set(repository, active.get(repository) + 1);
    maxActive.set(repository, Math.max(maxActive.get(repository), active.get(repository)));
    try {
      if (requests.get(repository) === 1) {
        started.get(`${repository}:resolve`)();
        await release.get(repository);
      } else if (requests.get(repository) === 2) {
        secondStarted.get(`${repository}:resolve`)();
        await releaseSecond.get(repository);
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/${sha}</id><title>unchanged</title></entry></feed>`,
      };
    } finally {
      active.set(repository, active.get(repository) - 1);
    }
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [
      { repository: priorityRepository, launchpad: "test", priority: true, baselineOnly: true },
      { repository: regularRepository, launchpad: "test", baselineOnly: true },
    ],
    sendAlertsImpl: async () => {},
  });

  const firstPriority = monitor.check(true);
  const firstRegular = monitor.check(false);
  await Promise.all([started.get(priorityRepository), started.get(regularRepository)]);
  const overlapping = [monitor.check(true), monitor.check(true), monitor.check(false), monitor.check(false)];
  release.get(`${priorityRepository}:resolve`)();
  release.get(`${regularRepository}:resolve`)();
  await Promise.all([secondStarted.get(priorityRepository), secondStarted.get(regularRepository)]);
  const duringCatchup = [monitor.check(true), monitor.check(false)];
  releaseSecond.get(`${priorityRepository}:resolve`)();
  releaseSecond.get(`${regularRepository}:resolve`)();
  await Promise.all([firstPriority, firstRegular, ...overlapping, ...duringCatchup]);

  assert.deepEqual(Object.fromEntries(requests), {
    [priorityRepository]: 2,
    [regularRepository]: 2,
  });
  assert.deepEqual(Object.fromEntries(maxActive), {
    [priorityRepository]: 1,
    [regularRepository]: 1,
  });
});

test("GitHub keeps both startup probes immediate then phases sixty-second repository lanes by thirty seconds", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-lane-phase-"));
  const priorityRepository = "cadence-fixture/priority";
  const regularRepository = "cadence-fixture/regular";
  const atomRequests = new Map([[priorityRepository, 0], [regularRepository, 0]]);
  const intervals = [];
  const timeouts = [];
  const clearedIntervals = new Set();
  const clearedTimeouts = new Set();
  const timerHandle = (kind, callback, delay) => ({
    kind,
    callback,
    delay,
    unref() {},
  });
  const waitFor = async (predicate, message) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(message);
  };
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(priorityRepository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com" && parsed.pathname.startsWith("/orgs/")) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => [] };
    }
    const atom = String(url).match(/^https:\/\/github\.com\/(cadence-fixture\/(?:priority|regular))\/commits\/main\.atom$/);
    assert.ok(atom, `unexpected GitHub cadence request: ${url}`);
    atomRequests.set(atom[1], atomRequests.get(atom[1]) + 1);
    return { ok: false, status: 304, headers: new Headers() };
  });

  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    githubPollIntervalMs: 5_000,
    githubPriorityPollIntervalMs: 5_000,
  }, {
    repositories: [
      { repository: priorityRepository, launchpad: "test", priority: true, baselineOnly: true },
      { repository: regularRepository, launchpad: "test", baselineOnly: true },
    ],
    pullRequestRepositories: [],
    sendAlertsImpl: async () => ({ status: "queued" }),
    now: () => new Date("2026-08-08T00:00:00.000Z"),
    setIntervalImpl: (callback, delay) => {
      const handle = timerHandle("interval", callback, delay);
      intervals.push(handle);
      return handle;
    },
    clearIntervalImpl: (handle) => { clearedIntervals.add(handle); },
    setTimeoutImpl: (callback, delay) => {
      const handle = timerHandle("timeout", callback, delay);
      timeouts.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => { clearedTimeouts.add(handle); },
  });

  await waitFor(
    () => atomRequests.get(priorityRepository) === 1 && atomRequests.get(regularRepository) === 1,
    "both startup repository lanes should check immediately",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(monitor.pollingIntervals.priorityRepositoryMs, 60_000);
  assert.deepEqual(monitor.pollingIntervals.regularSchedulerMs, 60_000);
  assert.deepEqual(timeouts.map(({ delay }) => delay), [30_000]);
  assert.deepEqual(intervals.map(({ delay }) => delay), [60_000, 600_000, 60_000], "priority recurrence waits for its phase offset");

  await timeouts[0].callback();
  assert.equal(atomRequests.get(priorityRepository), 2, "the phase callback should check only the priority lane");
  assert.equal(atomRequests.get(regularRepository), 1);
  assert.deepEqual(intervals.map(({ delay }) => delay), [60_000, 600_000, 60_000, 60_000]);

  await intervals[0].callback();
  assert.equal(atomRequests.get(regularRepository), 2, "the regular lane should recur independently at sixty seconds");
  assert.equal(atomRequests.get(priorityRepository), 2);
  await intervals[3].callback();
  assert.equal(atomRequests.get(priorityRepository), 3, "the phased priority lane should recur every sixty seconds");
  assert.equal(atomRequests.get(regularRepository), 2);

  await monitor.stop();
  assert.equal(clearedIntervals.size, 4);
  assert.equal(clearedTimeouts.size, 0, "the fired phase timeout is no longer pending at shutdown");
});

test("GitHub stop clears a pending priority phase and rejects its late callback", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pending-phase-stop-"));
  const priorityRepository = "cadence-fixture/priority-stop";
  let atomRequests = 0;
  const intervals = [];
  const timeouts = [];
  const clearedIntervals = new Set();
  const clearedTimeouts = new Set();
  const timerHandle = (kind, callback, delay) => ({
    kind,
    callback,
    delay,
    unref() {},
  });
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(priorityRepository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com" && parsed.pathname.startsWith("/orgs/")) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => [] };
    }
    if (parsed.hostname === "github.com" && parsed.pathname === `/${priorityRepository}/commits/main.atom`) {
      atomRequests += 1;
      return { ok: false, status: 304, headers: new Headers() };
    }
    throw new Error(`unexpected GitHub pending-phase request: ${url}`);
  });

  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    repositories: [{ repository: priorityRepository, launchpad: "test", priority: true, baselineOnly: true }],
    pullRequestRepositories: [],
    sendAlertsImpl: async () => ({ status: "queued" }),
    setIntervalImpl: (callback, delay) => {
      const handle = timerHandle("interval", callback, delay);
      intervals.push(handle);
      return handle;
    },
    clearIntervalImpl: (handle) => { clearedIntervals.add(handle); },
    setTimeoutImpl: (callback, delay) => {
      const handle = timerHandle("timeout", callback, delay);
      timeouts.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => { clearedTimeouts.add(handle); },
  });

  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].delay, 30_000);
  await monitor.stop();
  assert.deepEqual([...clearedTimeouts], [timeouts[0]], "shutdown clears the still-pending phase timeout");
  assert.equal(clearedIntervals.size, 3, "shutdown clears only the recurring timers that already exist");

  const intervalCountAfterStop = intervals.length;
  const requestCountAfterStop = atomRequests;
  await timeouts[0].callback();
  assert.equal(intervals.length, intervalCountAfterStop, "a late phase callback cannot create the priority interval");
  assert.equal(atomRequests, requestCountAfterStop, "a late phase callback cannot start another priority request");
});

test("falls back to user repositories when an official Four.Meme account is not an organization", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-account-fallback-"));
  const requests = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname === "/orgs/Four-Meme/repos") {
      return { ok: false, status: 404, json: async () => ({ message: "Not Found" }) };
    }
    if (pathname === "/users/Four-Meme/repos") {
      return { ok: true, status: 200, json: async () => [{ full_name: "Four-Meme/Four-Smart-Contracts", archived: false }] };
    }
    if (pathname === "/orgs/four-meme-community/repos") {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (pathname === "/orgs/flap-sh/repos") {
      return { ok: true, status: 200, json: async () => [{ full_name: "flap-sh/flap-skills", archived: false }] };
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "test-token" }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => {},
    now: () => new Date("2026-07-31T01:00:00Z"),
  });
  await monitor.checkOrganizations();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(requests.includes("/orgs/Four-Meme/repos"), true);
  assert.equal(requests.includes("/users/Four-Meme/repos"), true);
  assert.deepEqual(state._organizations["Four-Meme"].repositories, ["Four-Meme/Four-Smart-Contracts"]);
  assert.equal(state._organizations["Four-Meme"].lastError, null);
  assert.equal(state._repositories["Four-Meme/Four-Smart-Contracts"].sourceTrust, "unverified_candidate");
  assert.deepEqual(state._organizations["flap-sh"].repositories, ["flap-sh/flap-skills"]);
  assert.equal(state._repositories["flap-sh/flap-skills"].sourceTrust, "official_verified");
});

test("organization enumeration retries without a token after an authenticated 403", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-org-public-fallback-"));
  const requests = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    const authenticated = Boolean(options.headers?.authorization);
    requests.push({ pathname, authenticated });
    if (pathname === "/orgs/flap-sh/repos" && authenticated) {
      return { ok: false, status: 403, json: async () => ({ message: "rate limited" }) };
    }
    if (pathname === "/orgs/flap-sh/repos") {
      return { ok: true, status: 200, json: async () => [{ full_name: "flap-sh/flap-skills", archived: false }] };
    }
    return { ok: true, status: 200, json: async () => [] };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "expired-token" }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => {},
    now: () => new Date("2026-08-02T09:00:00Z"),
  });

  await monitor.checkOrganizations();
  const flapRequests = requests.filter(({ pathname }) => pathname === "/orgs/flap-sh/repos");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.deepEqual(flapRequests.map(({ authenticated }) => authenticated), [true, false]);
  assert.equal(state._organizations["flap-sh"].lastError, null);
  assert.equal(state._organizations["flap-sh"].lastSuccessAt, "2026-08-02T09:00:00.000Z");
  assert.deepEqual(state._organizations["flap-sh"].repositories, ["flap-sh/flap-skills"]);
});

test("Uniswap organization discovery admits official deploy, chain, and network repositories without a Robinhood default chain", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-uniswap-chain-repositories-"));
  const uniswapRepositories = [
    "Uniswap/deployments",
    "Uniswap/networks",
    "Uniswap/chain-registry",
    "Uniswap/network-tools",
    "Uniswap/deploy-v4",
    "Uniswap/continuous-clearing-auction",
    "Uniswap/uerc20-factory",
    "Uniswap/uniswap-ai",
    "Uniswap/random-docs",
  ];
  t.after(() => {
    for (const repository of uniswapRepositories) PRIORITY_REPOSITORIES.delete(repository.toLowerCase());
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/orgs/Uniswap/repos") {
      return { ok: true, status: 200, json: async () => uniswapRepositories.map((full_name) => ({ full_name, archived: false })) };
    }
    if (["/orgs/Four-Meme/repos", "/orgs/four-meme-community/repos", "/orgs/flap-sh/repos"].includes(pathname)) {
      return { ok: true, status: 200, json: async () => [] };
    }
    throw new Error(`unexpected GitHub organization request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", monitorScope: "focus3", ponsMonitorEnabled: false }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => {},
    now: () => new Date("2026-08-08T02:00:00Z"),
  });

  await monitor.checkOrganizations();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  for (const repository of uniswapRepositories.slice(0, -1)) {
    assert.ok(state._repositories[repository], `${repository} must be admitted by official organization discovery`);
    assert.equal(state._repositories[repository].sourceTrust, "official_verified");
    assert.equal(state._repositories[repository].uniswapOfficial, true);
    assert.equal(Object.hasOwn(state._repositories[repository], "chainId"), false);
  }
  assert.equal(state._repositories["Uniswap/random-docs"], undefined);
  assert.equal(isRelevantRepositoryFile("Uniswap/deployments", "networks/base.json"), true);
});

test("a newly discovered official repository retains its GitHub purpose and creation metadata", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-org-repository-metadata-"));
  const alerts = [];
  let includeNewRepository = false;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/orgs/Uniswap/repos") {
      const repositories = [{ full_name: "Uniswap/liquidity-launcher", archived: false }];
      if (includeNewRepository) repositories.push({
        full_name: "Uniswap/liquidity-launcher-v2",
        archived: false,
        description: "Contracts and SDK for Liquidity Launcher V2",
        created_at: "2026-08-08T02:00:00Z",
        pushed_at: "2026-08-08T02:03:00Z",
        html_url: "https://github.com/Uniswap/liquidity-launcher-v2",
        language: "TypeScript",
        topics: ["liquidity", "launcher"],
      });
      return { ok: true, status: 200, json: async () => repositories };
    }
    if (pathname === "/Uniswap/liquidity-launcher-v2/commits/main.atom") {
      return {
        ok: true,
        status: 200,
        text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/abcdef01</id><updated>2026-08-08T02:03:00Z</updated><title>feat: add LiquidityLauncherV2 strategy</title></entry></feed>`,
      };
    }
    if (pathname === "/Uniswap/liquidity-launcher-v2/commit/abcdef01.patch") {
      return {
        ok: true,
        status: 200,
        text: async () => "diff --git a/src/LiquidityLauncherV2.sol b/src/LiquidityLauncherV2.sol\nnew file mode 100644\n--- /dev/null\n+++ b/src/LiquidityLauncherV2.sol\n+contract LiquidityLauncherV2 {}",
      };
    }
    if (["/orgs/Four-Meme/repos", "/orgs/four-meme-community/repos", "/orgs/flap-sh/repos"].includes(pathname)) {
      return { ok: true, status: 200, json: async () => [] };
    }
    throw new Error(`unexpected GitHub organization request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", monitorScope: "focus3", ponsMonitorEnabled: false }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date("2026-08-08T02:05:00Z"),
  });

  await monitor.checkOrganizations();
  assert.equal(alerts.length, 0, "the first organization scan remains a silent baseline");
  includeNewRepository = true;
  await monitor.checkOrganizations();
  assert.equal(alerts.length, 2, "repository discovery and its recent structural first commit are both analyzed");
  const discovery = alerts.find((event) => event.type === "github_repository_discovered");
  const firstCommit = alerts.find((event) => event.type === "github_module_update");
  assert.equal(discovery.sourceTrust, "official_verified");
  assert.equal(discovery.createdAt, "2026-08-08T02:00:00Z");
  assert.deepEqual(discovery.repositoryMetadata, {
    description: "Contracts and SDK for Liquidity Launcher V2",
    createdAt: "2026-08-08T02:00:00Z",
    pushedAt: "2026-08-08T02:03:00Z",
    language: "TypeScript",
    topics: ["liquidity", "launcher"],
    homepage: null,
  });
  assert.equal(firstCommit.commit, "abcdef01");
  assert.equal(firstCommit.committedAt, "2026-08-08T02:03:00Z");
  assert.equal(firstCommit.modeChange.candidate, true);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state["Uniswap/liquidity-launcher-v2"].sha, "abcdef01");
  assert.equal(state["Uniswap/liquidity-launcher-v2"].coverage.status, "initial_bounded_catchup");
});

test("xAI and X developer organizations baseline silently, alert only product repositories, and monitor every new repository", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-ai-organization-discovery-"));
  const alerts = [];
  let secondScan = false;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com" && parsed.pathname === "/orgs/xai-org/repos") {
      const repositories = [
        { full_name: "xai-org/internal-tools", archived: false, description: "Internal build utilities", topics: [], pushed_at: "2026-08-12T04:00:00Z" },
        { full_name: "xai-org/grok-labs", archived: false, description: "Grok experiments", topics: ["grok"], pushed_at: "2026-08-12T04:00:00Z" },
      ];
      if (secondScan) repositories.push(
        {
          full_name: "xai-org/phoenix",
          archived: false,
          description: "New model API and SDK",
          topics: ["developer-tools"],
          created_at: "2026-08-12T04:01:00Z",
          pushed_at: "2026-08-12T04:02:00Z",
          html_url: "https://github.com/xai-org/phoenix",
        },
        {
          full_name: "xai-org/office-site",
          archived: false,
          description: "Corporate office website",
          topics: ["website"],
          created_at: "2026-08-12T04:01:30Z",
          pushed_at: "2026-08-12T04:02:30Z",
          html_url: "https://github.com/xai-org/office-site",
        },
      );
      return { ok: true, status: 200, json: async () => repositories };
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname === "/orgs/xdevplatform/repos") {
      return {
        ok: true,
        status: 200,
        json: async () => secondScan ? [{
          full_name: "xdevplatform/status-pages",
          archived: false,
          description: "Developer release surface",
          topics: ["xdk", "api"],
          created_at: "2026-08-12T04:01:45Z",
          pushed_at: "2026-08-12T04:02:45Z",
          html_url: "https://github.com/xdevplatform/status-pages",
        }] : [],
      };
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname.startsWith("/orgs/")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (parsed.hostname === "github.com" && parsed.pathname.endsWith("/commits/main.atom")) {
      return {
        ok: true,
        status: 200,
        text: async () => "<feed><entry><id>tag:github.com,2008:Grit::Commit/abcdef12</id><updated>2026-08-12T04:02:59Z</updated><title>repository baseline</title></entry></feed>",
      };
    }
    if (parsed.hostname === "github.com" && parsed.pathname.endsWith("/commit/abcdef12.patch")) {
      return {
        ok: true,
        status: 200,
        text: async () => "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n+ repository baseline",
      };
    }
    throw new Error(`unexpected GitHub AI organization request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", xaiOfficialMonitorEnabled: true }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "queued" }; },
    now: () => new Date("2026-08-12T04:03:00Z"),
  });

  await monitor.checkOrganizations();
  assert.equal(alerts.length, 0, "the first xAI/X organization scan must be a silent baseline");

  secondScan = true;
  await monitor.checkOrganizations();
  assert.deepEqual(alerts.map(({ repository }) => repository).sort(), [
    "xai-org/phoenix",
    "xdevplatform/status-pages",
  ]);
  const xaiEvent = alerts.find(({ repository }) => repository === "xai-org/phoenix");
  assert.equal(xaiEvent.xaiOfficial, true);
  assert.equal(xaiEvent.officialOrganization, "xai-org");
  assert.deepEqual(xaiEvent.officialEvidence, {
    source: "official_x_github_organization",
    url: "https://github.com/xai-org",
  });
  assert.equal(xaiEvent.sourceTrust, "official_verified");
  assert.equal(xaiEvent.strong, true);
  assert.deepEqual(xaiEvent.product, { id: "grok", name: "xAI / Grok" });
  assert.deepEqual(alerts.find(({ repository }) => repository === "xdevplatform/status-pages").product, {
    id: "x-api",
    name: "X API / Developer Platform",
  });

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  for (const repository of [
    "xai-org/phoenix",
    "xdevplatform/status-pages",
    "xai-org/office-site",
  ]) {
    assert.equal(state._repositories[repository].xaiOfficial, true);
    assert.equal(state._repositories[repository].priority, false);
    assert.equal(state._repositories[repository].pollingClass, "organization_dynamic");
    assert.equal(state[repository].sha, "abcdef12", `${repository} must receive a silent commit baseline`);
  }
  assert.equal(alerts.some(({ repository }) => repository === "xai-org/office-site"), false);
});

test("Binance organization discovery preserves official proof for a new Agent OS repository and analyzes its first commit", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-binance-agent-repository-discovery-"));
  const alerts = [];
  let secondScan = false;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com" && parsed.pathname === "/orgs/binance/repos") {
      const repositories = [{ full_name: "binance/binance-skills-hub", archived: false }];
      if (secondScan) repositories.push({
        full_name: "binance/agent-os",
        archived: false,
        description: "Binance Agent Native runtime and MCP Server",
        topics: ["agent-native", "mcp"],
        created_at: "2026-08-20T10:05:00Z",
        pushed_at: "2026-08-20T10:06:00Z",
        html_url: "https://github.com/binance/agent-os",
      });
      return { ok: true, status: 200, json: async () => repositories };
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname.startsWith("/orgs/")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (parsed.hostname === "github.com" && parsed.pathname === "/binance/agent-os/commits/main.atom") {
      return {
        ok: true,
        status: 200,
        text: async () => "<feed><entry><id>tag:github.com,2008:Grit::Commit/abcdef99</id><updated>2026-08-20T10:06:00Z</updated><title>Publish Agent OS and Binance MCP Server</title></entry></feed>",
      };
    }
    if (parsed.hostname === "github.com" && parsed.pathname === "/binance/agent-os/commit/abcdef99.patch") {
      return {
        ok: true,
        status: 200,
        text: async () => "diff --git a/README.md b/README.md\nnew file mode 100644\n--- /dev/null\n+++ b/README.md\n+Binance Agent OS\n+Connect through the Binance MCP Server",
      };
    }
    throw new Error(`unexpected GitHub Binance organization request: ${url}`);
  });
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    monitorScope: "focus3",
    binanceMonitorEnabled: true,
    ponsMonitorEnabled: false,
  }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "queued" }; },
    now: () => new Date("2026-08-20T10:07:00Z"),
  });

  await monitor.checkOrganizations();
  assert.equal(alerts.length, 0);
  secondScan = true;
  await monitor.checkOrganizations();

  const discovery = alerts.find((event) => event.type === "github_repository_discovered");
  assert.equal(discovery.repository, "binance/agent-os");
  assert.equal(discovery.sourceTrust, "official_verified");
  assert.equal(discovery.officialOrganization, "binance");
  assert.deepEqual(discovery.officialEvidence, {
    source: "official_binance_github",
    url: "https://github.com/binance",
  });
  assert.equal(discovery.strong, true);
  assert.deepEqual(discovery.product, { id: "binance-agent-platform", name: "Binance Agent Platform" });
  assert.equal(alerts.some((event) => event.type === "github_module_update" && event.repository === "binance/agent-os"), true);
});

test("organization discovery keeps explicit core repositories fast and assigns dynamic repositories to the gated cadence", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-org-dynamic-cadence-"));
  const dynamicRepository = "flap-sh/experimental-launcher";
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(dynamicRepository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/orgs/flap-sh/repos") {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { full_name: "flap-sh/flap-skills", archived: false, pushed_at: "2026-08-08T03:00:00Z" },
          { full_name: dynamicRepository, archived: false, pushed_at: "2026-08-08T03:01:00Z" },
        ],
      };
    }
    if (pathname.startsWith("/orgs/")) return { ok: true, status: 200, json: async () => [] };
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    githubDynamicPollIntervalMs: 300_000,
    githubOrganizationPollIntervalMs: 900_000,
  }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => {},
    now: () => new Date("2026-08-08T03:02:00Z"),
  });

  await monitor.checkOrganizations();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._repositories["flap-sh/flap-skills"].priority, true);
  assert.equal(state._repositories["flap-sh/flap-skills"].pollingClass, "core_priority");
  assert.equal(state._repositories[dynamicRepository].priority, false);
  assert.equal(state._repositories[dynamicRepository].pollingClass, "organization_dynamic");
  assert.equal(PRIORITY_REPOSITORIES.has("flap-sh/flap-skills"), true);
  assert.equal(PRIORITY_REPOSITORIES.has(dynamicRepository), false);
  assert.deepEqual(monitor.pollingIntervals, {
    priorityRepositoryMs: 60_000,
    regularSchedulerMs: 60_000,
    dynamicRepositoryMs: 300_000,
    organizationMs: 600_000,
    requestTimeoutMs: 8_000,
  });
});

test("legacy organization repositories are migrated out of the priority loop on restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-org-priority-migration-"));
  const repository = "flap-sh/legacy-dynamic-module";
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    _repositories: {
      [repository]: {
        repository,
        launchpad: "Flap",
        sourceTrust: "official_verified",
        officialOrganization: "flap-sh",
        priority: true,
        baselineOnly: true,
      },
    },
  }));
  PRIORITY_REPOSITORIES.add(repository);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(`/${repository}/commits/main.atom`)) {
      return { ok: true, status: 200, text: async () => "<feed></feed>" };
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    githubDynamicPollIntervalMs: 300_000,
  }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => {},
  });

  await monitor.check(false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(PRIORITY_REPOSITORIES.has(repository), false);
  assert.equal(state._repositories[repository].priority, false);
  assert.equal(state._repositories[repository].pollingClass, "organization_dynamic");
});

test("a persisted Binance Go connector discovery migrates to configured regular polling without replaying its commit cursor", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-binance-go-configured-migration-"));
  const repository = "binance/binance-connector-go";
  const persistedSha = "bbbb0002";
  const alerts = [];
  let atomRequests = 0;
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: persistedSha, checkedAt: "2026-08-19T12:59:00.000Z" },
    _repositories: {
      [repository]: {
        repository,
        launchpad: "Binance",
        sourceTrust: "official_verified",
        officialOrganization: "binance",
        officialEvidence: { source: "official_binance_github", url: "https://github.com/binance" },
        pollingClass: "organization_dynamic",
        priority: false,
        baselineOnly: true,
        initialCatchupRequired: true,
        organizationPushedAt: "2026-08-19T12:58:00.000Z",
      },
    },
    _health: {
      repositories: {
        [repository]: {
          repository,
          launchpad: "Binance",
          status: "healthy",
          pollingClass: "organization_dynamic",
          priority: false,
          nextAttemptAt: "2026-08-19T13:05:00.000Z",
          lastSuccessAt: "2026-08-19T13:00:00.000Z",
        },
      },
    },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "github.com" && parsed.pathname === `/${repository}/commits/main.atom`) {
      atomRequests += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => [
          "<feed>",
          `<entry><id>tag:github.com,2008:Grit::Commit/${persistedSha}</id><updated>2026-08-19T12:58:00Z</updated><title>persisted head</title></entry>`,
          "<entry><id>tag:github.com,2008:Grit::Commit/aaaa0001</id><updated>2026-08-19T12:50:00Z</updated><title>older commit</title></entry>",
          "</feed>",
        ].join(""),
      };
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname === "/orgs/binance/repos") {
      return {
        ok: true,
        status: 200,
        json: async () => [{
          full_name: repository,
          archived: false,
          pushed_at: "2026-08-19T12:58:00.000Z",
        }],
      };
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname.startsWith("/orgs/")) {
      return { ok: true, status: 200, json: async () => [] };
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  const configured = DEFAULT_REPOSITORIES.find((entry) => entry.repository.toLowerCase() === repository);
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    monitorScope: "focus3",
    binanceMonitorEnabled: true,
    ponsMonitorEnabled: false,
    githubPollIntervalMs: 60_000,
    githubPriorityPollIntervalMs: 5_000,
    githubDynamicPollIntervalMs: 300_000,
  }, {
    autoStart: false,
    repositories: [configured],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date("2026-08-19T13:01:00.000Z"),
  });

  await monitor.check(false);
  await monitor.checkOrganizations();

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(atomRequests, 1, "the old five-minute dynamic nextAttemptAt must not delay the first regular poll");
  assert.equal(alerts.length, 0, "the persisted commit and older history must not be replayed");
  assert.equal(state[repository].sha, persistedSha);
  assert.equal(state._repositories[repository].pollingClass, "configured");
  assert.equal(state._repositories[repository].priority, false);
  assert.equal(state._repositories[repository].sourceTrust, "official_verified");
  assert.equal(state._repositories[repository].baselineOnly, true);
  assert.equal(state._repositories[repository].initialCatchupRequired, undefined);
  assert.deepEqual(state._repositories[repository].officialEvidence, configured.officialEvidence);
  assert.equal(state._health.repositories[repository].pollingClass, "core_or_configured");
  assert.equal(state._health.repositories[repository].nextAttemptAt, null);
  assert.equal(PRIORITY_REPOSITORIES.has(repository), false);
  assert.equal(monitor.pollingIntervals.regularSchedulerMs, 60_000);
  assert.equal(monitor.pollingIntervals.dynamicRepositoryMs, 300_000);
  assert.equal(monitor.pollingIntervals.priorityRepositoryMs, 60_000);
});

test("Binance Go connector cadence migration preserves an active GitHub policy backoff", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-binance-go-backoff-migration-"));
  const repository = "binance/binance-connector-go";
  let requests = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: "bbbb0002", checkedAt: "2026-08-19T12:59:00.000Z" },
    _repositories: {
      [repository]: {
        repository,
        launchpad: "Binance",
        sourceTrust: "official_verified",
        officialOrganization: "binance",
        pollingClass: "organization_dynamic",
        priority: false,
        baselineOnly: true,
      },
    },
    _health: {
      repositories: {
        [repository]: {
          repository,
          launchpad: "Binance",
          status: "degraded",
          pollingClass: "organization_dynamic",
          priority: false,
          consecutiveFailures: 1,
          lastErrorStatus: 429,
          nextAttemptAt: "2026-08-19T13:05:00.000Z",
        },
      },
    },
  }));
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new Error("an active 429 backoff must not be bypassed during cadence migration");
  });
  const configured = DEFAULT_REPOSITORIES.find((entry) => entry.repository.toLowerCase() === repository);
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    monitorScope: "focus3",
    binanceMonitorEnabled: true,
    ponsMonitorEnabled: false,
    githubPollIntervalMs: 60_000,
    githubDynamicPollIntervalMs: 300_000,
  }, {
    autoStart: false,
    repositories: [configured],
    sendAlertsImpl: async () => { throw new Error("backoff migration must not replay an alert"); },
    now: () => new Date("2026-08-19T13:01:00.000Z"),
  });

  await monitor.check(false);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(requests, 0);
  assert.equal(state[repository].sha, "bbbb0002");
  assert.equal(state._repositories[repository].pollingClass, "configured");
  assert.equal(state._health.repositories[repository].pollingClass, "core_or_configured");
  assert.equal(state._health.repositories[repository].status, "degraded");
  assert.equal(state._health.repositories[repository].nextAttemptAt, "2026-08-19T13:05:00.000Z");
});

test("persisted organization priority cannot override the explicit core fast lane", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-org-explicit-priority-migration-"));
  const repository = "Uniswap/uniswapx-parameterization-api";
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository.toLowerCase());
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  const legacyEntry = {
    repository,
    launchpad: "Uniswap",
    sourceTrust: "official_verified",
    officialOrganization: "Uniswap",
    uniswapOfficial: true,
    priority: true,
    baselineOnly: true,
  };
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    _repositories: { [repository]: legacyEntry },
  }));
  PRIORITY_REPOSITORIES.add(repository.toLowerCase());
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(`/${repository}/commits/main.atom`)) {
      return { ok: true, status: 200, text: async () => "<feed></feed>" };
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    githubDynamicPollIntervalMs: 300_000,
  }, {
    autoStart: false,
    repositories: [legacyEntry],
    sendAlertsImpl: async () => {},
  });

  await monitor.check(false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(PRIORITY_REPOSITORIES.has(repository.toLowerCase()), false);
  assert.equal(state._repositories[repository].priority, false);
  assert.equal(state._repositories[repository].pollingClass, "organization_dynamic");
});

test("successful organization snapshots retire absent and filtered dynamic repositories across restart without touching cursors or core repositories", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-org-retired-dynamic-"));
  const absentRepository = "xdevplatform/retired-sample-app";
  const filteredRepository = "Uniswap/random-docs";
  const coreRepository = "xdevplatform/xdk";
  const snapshotAt = "2026-08-08T03:50:00.000Z";
  let atomRequests = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [absentRepository]: { sha: "aaaa1001", checkedAt: snapshotAt },
    [filteredRepository]: { sha: "bbbb1002", checkedAt: snapshotAt },
    [coreRepository]: { sha: "cccc1003", checkedAt: snapshotAt },
    _repositories: {
      [absentRepository]: {
        repository: absentRepository,
        launchpad: "X",
        sourceTrust: "official_verified",
        officialOrganization: "xdevplatform",
        xaiOfficial: true,
        priority: false,
        pollingClass: "organization_dynamic",
        baselineOnly: true,
        organizationPushedAt: "2026-08-08T03:45:00.000Z",
      },
      [filteredRepository]: {
        repository: filteredRepository,
        launchpad: "Uniswap",
        sourceTrust: "official_verified",
        officialOrganization: "Uniswap",
        uniswapOfficial: true,
        priority: false,
        pollingClass: "organization_dynamic",
        baselineOnly: true,
        organizationPushedAt: "2026-08-08T03:46:00.000Z",
      },
      [coreRepository]: {
        repository: coreRepository,
        launchpad: "X",
        sourceTrust: "official_verified",
        officialOrganization: "xdevplatform",
        xaiOfficial: true,
        priority: false,
        pollingClass: "organization_dynamic",
        baselineOnly: true,
        organizationPushedAt: "2026-08-08T03:47:00.000Z",
      },
    },
    _organizations: {
      xdevplatform: {
        repositories: [absentRepository, coreRepository],
        lastSuccessAt: snapshotAt,
      },
      Uniswap: {
        repositories: [filteredRepository],
        lastSuccessAt: snapshotAt,
      },
    },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com" && parsed.pathname.startsWith("/orgs/")) {
      if (parsed.pathname === "/orgs/Uniswap/repos") {
        return { ok: true, status: 200, json: async () => [{ full_name: filteredRepository, archived: false }] };
      }
      return { ok: true, status: 200, json: async () => [] };
    }
    if (parsed.hostname === "github.com" && parsed.pathname.includes("/commits/")) {
      atomRequests += 1;
      throw new Error(`inactive repository must not read its Atom feed: ${url}`);
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  const config = {
    dataDir,
    githubToken: "",
    monitorScope: "focus3",
    xaiOfficialMonitorEnabled: true,
    ponsMonitorEnabled: false,
  };
  const dependencies = {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => {},
    now: () => new Date("2026-08-08T04:00:00.000Z"),
  };

  const monitor = createGithubMonitor(config, dependencies);
  await monitor.checkOrganizations();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(atomRequests, 0);
  assert.equal(state._repositories[absentRepository].active, false);
  assert.equal(state._repositories[absentRepository].inactiveReason, "organization_repository_absent");
  assert.equal(state._repositories[filteredRepository].active, false);
  assert.equal(state._repositories[filteredRepository].inactiveReason, "organization_discovery_filter");
  assert.equal(state[absentRepository].sha, "aaaa1001");
  assert.equal(state[filteredRepository].sha, "bbbb1002");
  assert.equal(state._repositories[coreRepository].pollingClass, "core_priority");
  assert.notEqual(state._repositories[coreRepository].active, false);
  assert.equal(state[coreRepository].sha, "cccc1003");

  const restarted = createGithubMonitor(config, dependencies);
  await restarted.check(false);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(atomRequests, 0, "retired dynamic repositories must remain inactive after restart");
  assert.equal(state._repositories[absentRepository].active, false);
  assert.equal(state._repositories[filteredRepository].active, false);
  assert.equal(state[absentRepository].sha, "aaaa1001");
  assert.equal(state[filteredRepository].sha, "bbbb1002");
});

test("dynamic repositories use pushed_at to skip unchanged commit feeds and bypass the timer when activity changes", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-org-pushed-gate-"));
  const repository = "flap-sh/experimental-pool-module";
  let currentTime = new Date("2026-08-08T04:00:00Z");
  let pushedAt = "2026-08-08T03:59:00Z";
  let atomRequests = 0;
  let atomFailure = false;
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/orgs/flap-sh/repos") {
      return { ok: true, status: 200, json: async () => [{ full_name: repository, archived: false, pushed_at: pushedAt }] };
    }
    if (parsed.pathname.startsWith("/orgs/")) return { ok: true, status: 200, json: async () => [] };
    if (parsed.pathname === `/${repository}/commits/main.atom`) {
      atomRequests += 1;
      if (atomFailure) return { ok: false, status: 503, headers: new Headers(), text: async () => "" };
      return {
        ok: true,
        status: 200,
        text: async () => '<feed><entry><id>tag:github.com,2008:Grit::Commit/aaaa0001</id><updated>2026-08-08T03:59:00Z</updated><title>baseline</title></entry></feed>',
      };
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname === `/repos/${repository}/commits` && atomFailure) {
      return { ok: false, status: 503, headers: new Headers(), json: async () => [] };
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    githubPollIntervalMs: 60_000,
    githubDynamicPollIntervalMs: 300_000,
    githubOrganizationPollIntervalMs: 600_000,
    githubRetryBaseMs: 300_000,
    githubRetryMaxMs: 600_000,
  }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => {},
    now: () => new Date(currentTime),
  });

  await monitor.checkOrganizations();
  await monitor.check(false);
  assert.equal(atomRequests, 1, "a new dynamic repository still establishes its commit baseline");

  currentTime = new Date("2026-08-08T04:10:00Z");
  await monitor.check(false);
  assert.equal(atomRequests, 1, "an unchanged pushed_at value gates the commit feed even after the dynamic interval expires");

  currentTime = new Date("2026-08-08T04:11:00Z");
  await monitor.checkOrganizations();
  assert.equal(atomRequests, 1, "a successful organization refresh with the same pushed_at value performs no commit read");

  currentTime = new Date("2026-08-08T04:12:00Z");
  pushedAt = "2026-08-08T04:12:00Z";
  await monitor.checkOrganizations();
  assert.equal(atomRequests, 2, "a changed pushed_at value triggers an immediate commit read");
  await monitor.check(false);
  assert.equal(atomRequests, 2, "the regular loop does not duplicate the pushed_at-triggered read");

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._health.repositories[repository].lastOrganizationPushedAt, pushedAt);
  assert.equal(state._health.repositories[repository].organizationPushGate, "commit_read");

  currentTime = new Date("2026-08-08T04:13:00Z");
  pushedAt = "2026-08-08T04:13:00Z";
  atomFailure = true;
  await monitor.checkOrganizations();
  assert.equal(atomRequests, 3, "a second pushed_at change gets one immediate attempt");
  await monitor.check(false);
  assert.equal(atomRequests, 3, "the failed immediate attempt is not duplicated by the regular loop");

  currentTime = new Date("2026-08-08T04:14:00Z");
  await monitor.check(false);
  assert.equal(atomRequests, 3, "the same pushed_at value cannot repeatedly bypass failure backoff");
});

test("organization enumeration falls back to the public GitHub repository page after API rate limits", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-org-html-fallback-"));
  const requests = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    requests.push(parsed.href);
    if (parsed.hostname === "api.github.com" && parsed.pathname === "/orgs/flap-sh/repos") {
      return { ok: false, status: 403, json: async () => ({ message: "rate limited" }) };
    }
    if (parsed.hostname === "github.com" && parsed.pathname === "/orgs/flap-sh/repositories") {
      return { ok: true, status: 200, text: async () => '<a href="/flap-sh/flap-skills">flap-skills</a>' };
    }
    if (parsed.hostname === "api.github.com") return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 200, text: async () => "" };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "expired-token" }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => {},
    now: () => new Date("2026-08-02T09:00:00Z"),
  });

  await monitor.checkOrganizations();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(requests.some((url) => url.includes("github.com/orgs/flap-sh/repositories")), true);
  assert.deepEqual(state._organizations["flap-sh"].repositories, ["flap-sh/flap-skills"]);
  assert.equal(state._organizations["flap-sh"].lastError, null);
});

test("does not hide GitHub service errors behind the user-account fallback", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-account-error-"));
  const requests = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const pathname = new URL(url).pathname;
    requests.push(pathname);
    if (pathname === "/orgs/Four-Meme/repos") {
      return { ok: false, status: 500, json: async () => ({ message: "Server Error" }) };
    }
    if (pathname === "/orgs/four-meme-community/repos") {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (pathname === "/orgs/flap-sh/repos") {
      return { ok: true, status: 200, json: async () => [] };
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "test-token" }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => {},
    now: () => new Date("2026-07-31T01:00:00Z"),
  });
  await monitor.checkOrganizations();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(requests.includes("/users/Four-Meme/repos"), false);
  assert.match(state._organizations["Four-Meme"].lastError, /HTTP 500/);
});

test("a failed public retry remains visible in organization health", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-org-public-error-"));
  const requests = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    requests.push({ pathname, authenticated: Boolean(options.headers?.authorization) });
    if (parsed.hostname === "github.com") {
      return { ok: false, status: 403, text: async () => "rate limited" };
    }
    if (pathname === "/orgs/Four-Meme/repos") {
      return { ok: false, status: 403, json: async () => ({ message: "rate limited" }) };
    }
    return { ok: true, status: 200, json: async () => [] };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "expired-token" }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => {},
    now: () => new Date("2026-08-02T09:05:00Z"),
  });

  await monitor.checkOrganizations();
  const attempts = requests.filter(({ pathname }) => pathname === "/orgs/Four-Meme/repos");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.deepEqual(attempts.map(({ authenticated }) => authenticated), [true, false]);
  assert.match(state._organizations["Four-Meme"].lastError, /HTTP 403/);
  assert.equal(state._organizations["Four-Meme"].lastErrorAt, "2026-08-02T09:05:00.000Z");
});

test("keeps meaningful content updates from official Four.Meme community repositories", () => {
  assert.equal(isRelevantRepositoryFile("four-meme-community/openfour-docs", "integration-guide.md"), true);
  assert.equal(isRelevantRepositoryFile("four-meme-community/four-meme-ai", "skills/four-meme-integration/SKILL.md"), true);
  assert.equal(isRelevantRepositoryFile("four-meme-community/openfour-docs", "media/logo.png"), false);
  assert.equal(isRelevantRepositoryFile("other/docs", "README.md"), false);
});

test("Four.Meme README copy is ignored unless it carries a structured product signal", () => {
  const commit = { commit: { message: "refresh wording" } };
  assert.equal(isSemanticallyRelevantFourMemeChange("four-meme/four-smart-contracts", commit, [{ filename: "README.md", patch: "+ nicer wording" }]), false);
  assert.equal(isSemanticallyRelevantFourMemeChange("four-meme/four-smart-contracts", commit, [{ filename: "README.md", patch: "+ quote token UUSD 0x1111111111111111111111111111111111111111" }]), true);
});

test("Four.Meme TaxToken9 charity donation code is a structural mode even with a generic commit title", () => {
  const commit = { commit: { message: "update feature documentation" } };
  const files = [{
    filename: "product-update/charity-donation.md",
    status: "modified",
    patch: "+ TaxToken9 enables transaction-tax donations to Giggle Charity and Binance Charity.\n+ Charity Badge and Charity Dashboard are now live.",
  }];
  assert.equal(isSemanticallyRelevantFourMemeChange("four-meme-community/openfour-docs", commit, files), true);
  assert.deepEqual(classifyGithubModeChange(commit.commit.message, files), {
    candidate: true,
    reason: "charity_donation_tax_mode",
    labels: ["charity_donation", "transaction_tax"],
    identifiers: ["TaxToken9"],
  });
});

test("new official repository state performs bounded relevant catch-up instead of a silent baseline", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-catchup-"));
  const repository = "four-meme-community/openfour-docs";
  const alerts = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const atom = `<feed>
    <entry><id>tag:github.com,2008:Grit::Commit/abcdef12</id><updated>2026-07-31T00:00:00Z</updated><link href="https://github.com/${repository}/commit/abcdef12"/><title>add UUSD quote token</title><author><name>dev</name></author></entry>
    <entry><id>tag:github.com,2008:Grit::Commit/abcdef11</id><updated>2026-07-30T00:00:00Z</updated><link href="https://github.com/${repository}/commit/abcdef11"/><title>contract config</title><author><name>dev</name></author></entry>
  </feed>`;
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true,
    status: 200,
    text: async () => String(url).endsWith(".atom")
      ? atom
      : "diff --git a/integration-guide.md b/integration-guide.md\n--- a/integration-guide.md\n+++ b/integration-guide.md\n+ BSC mainnet Factory: 0x1111111111111111111111111111111111111111",
  }));
  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    githubPollIntervalMs: 60_000,
    githubPriorityPollIntervalMs: 15_000,
  }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Four.meme", sourceTrust: "official_verified" }],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date("2026-07-31T01:00:00Z"),
  });
  await monitor.check(true);
  await monitor.check(true);
  assert.equal(alerts.filter((event) => event.type === "github_module_update").length, 2);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, "abcdef12");
  assert.equal(state[repository].coverage.status, "continuous");
  assert.equal(state[repository].initialCatchup.scanned, 2);
});

test("missing GitHub anchor emits and persists an explicit coverage gap", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-gap-"));
  const repository = "flap-sh/flap-skills";
  const alerts = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({ [repository]: { sha: "deadbeef" } }));
  const atom = `<feed><entry><id>tag:github.com,2008:Grit::Commit/abcdef12</id><updated>2026-07-31T00:00:00Z</updated><link href="https://github.com/${repository}/commit/abcdef12"/><title>v2 contract</title></entry></feed>`;
  t.mock.method(globalThis, "fetch", async (url) => ({
    ok: true,
    status: 200,
    text: async () => String(url).endsWith(".atom") ? atom : "diff --git a/contracts/V2.sol b/contracts/V2.sol\nnew file mode 100644\n+++ b/contracts/V2.sol\n+ contract V2 {}",
  }));
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified", priority: true }],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date("2026-07-31T01:00:00Z"),
  });
  await monitor.check(true);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  const gapAlert = alerts.find((event) => event.type === "github_monitor_gap");
  assert.equal(gapAlert.sourceTrust, "official_verified");
  assert.equal(gapAlert.priority, true);
  assert.equal(gapAlert.pollingClass, "core_priority");
  assert.deepEqual(gapAlert.verification, { status: "official_verified", evidence: null });
  assert.equal(state[repository].sha, "deadbeef");
  assert.equal(state[repository].gap.status, "anchor_not_in_bounded_history");
  assert.equal(state[repository].coverage.status, "gap_unresolved");
  assert.equal(state._health.repositories[repository].status, "degraded");
});

test("a no-token Atom gap paginates the unauthenticated API before advancing the cursor", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-gap-api-recovery-"));
  const repository = "flap-sh/flap-skills";
  const alerts = [];
  const apiPages = [];
  const commit = (sha, message, authorDate, committerDate) => ({
    sha,
    html_url: `https://github.com/${repository}/commit/${sha}`,
    commit: { message, author: { name: "dev", date: authorDate }, committer: { date: committerDate } },
  });
  const newest = commit("cccc0003", "add v3 module", "2020-01-01T00:00:00Z", "2026-08-06T00:00:03Z");
  const middle = commit("bbbb0002", "add v2 module", "2026-08-06T00:00:02Z", "2026-08-06T00:00:02Z");
  const anchor = commit("aaaa0001", "old", "2026-08-06T00:00:01Z", "2026-08-06T00:00:01Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({ [repository]: { sha: anchor.sha } }));
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.github.com") {
      assert.equal(Boolean(options.headers?.authorization), false);
      const page = Number(parsed.searchParams.get("page"));
      apiPages.push(page);
      return {
        ok: true,
        status: 200,
        json: async () => page === 1 ? Array.from({ length: 100 }, () => newest) : [middle, anchor],
      };
    }
    if (parsed.pathname.endsWith(".atom")) {
      return {
        ok: true,
        status: 200,
        text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/${newest.sha}</id><updated>2026-08-06T00:00:03Z</updated><title>${newest.commit.message}</title></entry></feed>`,
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "diff --git a/skills/flap/SKILL.md b/skills/flap/SKILL.md\n+++ b/skills/flap/SKILL.md\n+ launch module",
    };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified" }],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date("2026-08-06T00:01:00Z"),
  });
  await monitor.check(true);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.deepEqual(apiPages, [1, 2]);
  assert.deepEqual(alerts.filter(({ type }) => type === "github_module_update").map(({ commit: sha }) => sha), [middle.sha, newest.sha]);
  assert.equal(alerts.find(({ commit: sha }) => sha === newest.sha).committedAt, "2026-08-06T00:00:03Z");
  assert.equal(state[repository].sha, newest.sha);
  assert.equal(state[repository].coverage.status, "continuous");
  assert.equal(state[repository].gap, null);
});

test("a real-size terminal gap keeps full in-memory evidence, durably queues only a bounded projection, and catches up after restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-large-gap-compact-"));
  const repository = "flap-sh/flap-skills";
  const entry = DEFAULT_REPOSITORIES.find(({ repository: candidate }) => candidate === repository);
  const anchorSha = "a".repeat(40);
  const shaFor = (value) => value.toString(16).padStart(40, "0");
  const makeCommit = (sha, message, padding = "") => ({
    sha,
    html_url: `https://github.com/${repository}/commit/${sha}`,
    commit: {
      message,
      author: { name: "xAI", date: "2026-08-20T00:00:00.000Z" },
      committer: { date: "2026-08-20T00:00:00.000Z" },
    },
    evidencePadding: padding,
  });
  const terminalCommits = Array.from({ length: 1_000 }, (_, index) => makeCommit(
    shaFor(2_000 - index),
    `historical product commit ${index}`,
    "x".repeat(4_500),
  ));
  const newest = makeCommit(terminalCommits[0].sha, "feat: add Grok 5 Responses API endpoint");
  const middle = makeCommit(shaFor(999), "feat: add Grok 5 realtime Responses API endpoint");
  const anchor = makeCommit(anchorSha, "previous cursor");
  let phase = "terminal_gap";
  let current = new Date("2026-08-20T00:01:00.000Z");
  // Keep outbox retention on the same clock as the monitor and alert pipeline.
  t.mock.method(Date, "now", () => current.getTime());
  let gapAlertStoredBoundedPayload = false;
  let terminalSuppressions = 0;
  const deliveredCommits = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: anchorSha, checkedAt: "2026-08-20T00:00:00.000Z" },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "api.telegram.org") {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, result: { message_id: 4242 } }),
      };
    }
    if (parsed.hostname === "github.com" && parsed.pathname.endsWith(".atom")) {
      return {
        ok: true,
        status: 200,
        text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/${newest.sha}</id><updated>2026-08-20T00:00:03Z</updated><title>${newest.commit.message}</title></entry></feed>`,
      };
    }
    if (parsed.hostname === "api.github.com") {
      const page = Number(parsed.searchParams.get("page"));
      return {
        ok: true,
        status: 200,
        json: async () => phase === "terminal_gap"
          ? terminalCommits.slice((page - 1) * 100, page * 100)
          : page === 1 ? [newest, middle, anchor] : [],
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "diff --git a/src/xai_sdk/responses.py b/src/xai_sdk/responses.py\n+++ b/src/xai_sdk/responses.py\n+class Grok5ResponsesApi: pass",
    };
  });
  const options = {
    autoStart: false,
    repositories: [entry],
    now: () => new Date(current),
    sendAlertsImpl: async (_config, event) => {
      if (event.type === "github_monitor_gap") {
        assert.equal(event.gap.recovery.commits, undefined, "the durable delivery boundary must not receive raw commit history");
        assert.equal(event.gap.recovery.compactEvidence.count, 1_000);
        assert.ok(event.gap.recovery.compactEvidence.rawBytes > 4_000_000);
        assert.match(event.gap.recovery.compactEvidence.digest, /^sha256:[a-f0-9]{64}$/);
        const beforePersistence = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
        assert.equal(beforePersistence[repository].gap, undefined, "compaction and persistence must happen after the alert resolves");
        const delivery = await sendAlerts(_config, event);
        assert.equal(delivery.status, "suppressed");
        assert.equal(delivery.reason, "policy_suppressed", "an operational coverage gap is audit-only in the trading channel");
        const outboxFile = await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8");
        const outbox = JSON.parse(outboxFile);
        const queuedGap = outbox.events[event.eventKey]?.event?.gap;
        assert.equal(queuedGap?.recovery?.commits, undefined);
        assert.equal(queuedGap?.recovery?.compactEvidence?.count, 1_000);
        assert.ok(Buffer.byteLength(outboxFile) < 50_000, "the durable outbox must stay bounded after a multi-megabyte gap");
        gapAlertStoredBoundedPayload = true;
        return delivery;
      }
      if (event.type === "github_module_update") {
        terminalSuppressions += 1;
        deliveredCommits.push(event.commit);
        return { status: "suppressed", reason: "freshness_too_old", disposition: "terminal", terminal: true };
      }
      return undefined;
    },
  };

  const monitor = createGithubMonitor({
    dataDir,
    githubToken: "",
    githubRetryBaseMs: 1_000,
    githubRetryMaxMs: 8_000,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token-secret",
    telegramChatId: "1234567890",
    telegramStrongAlerts: false,
    alertBilingualEnabled: false,
    alertNow: () => current.getTime(),
  }, options);
  await monitor.check(true);
  const compactFile = await fs.readFile(path.join(dataDir, "github-state.json"), "utf8");
  let state = JSON.parse(compactFile);
  const compactRecovery = state[repository].gap.recovery;
  assert.equal(gapAlertStoredBoundedPayload, true);
  assert.equal(state[repository].sha, anchorSha, "an unresolved gap must never move the cursor");
  assert.equal(compactRecovery.commits, undefined);
  assert.equal(compactRecovery.compactEvidence.classification, "terminal_anchor_not_found");
  assert.equal(compactRecovery.compactEvidence.count, 1_000);
  assert.equal(compactRecovery.compactEvidence.observedAt, "2026-08-20T00:01:00.000Z");
  assert.equal(compactRecovery.compactEvidence.anchorRange.requestedSha, anchorSha);
  assert.equal(compactRecovery.compactEvidence.anchorRange.newestFetchedSha, terminalCommits[0].sha);
  assert.equal(compactRecovery.compactEvidence.anchorRange.oldestFetchedSha, terminalCommits.at(-1).sha);
  assert.ok(compactRecovery.compactEvidence.rawBytes > 4_000_000);
  assert.match(compactRecovery.compactEvidence.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(compactRecovery.compactEvidence.selectedFacts.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(compactRecovery)) < 2_048, "terminal recovery evidence must have a strict byte budget");
  assert.ok(Buffer.byteLength(compactFile) < 20_000, "the whole state checkpoint must not retain the multi-megabyte gap payload");

  phase = "resolved_gap";
  current = new Date("2026-08-20T00:01:02.000Z");
  const restarted = createGithubMonitor({
    dataDir,
    githubToken: "",
    githubRetryBaseMs: 1_000,
    githubRetryMaxMs: 8_000,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token-secret",
    telegramChatId: "1234567890",
    telegramStrongAlerts: false,
    alertBilingualEnabled: false,
    alertNow: () => current.getTime(),
  }, options);
  await restarted.check(true);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.deepEqual(deliveredCommits, [middle.sha, newest.sha]);
  assert.equal(terminalSuppressions, 2);
  assert.equal(state[repository].sha, newest.sha);
  assert.equal(state[repository].gap, null);
  assert.equal(state[repository].coverage.status, "continuous");

  current = new Date("2026-08-20T00:01:03.000Z");
  const restartedAgain = createGithubMonitor({
    dataDir,
    githubToken: "",
    blockedContracts: new Set(),
    telegramToken: "test-bot-token-secret",
    telegramChatId: "1234567890",
    telegramStrongAlerts: false,
    alertBilingualEnabled: false,
    alertNow: () => current.getTime(),
  }, options);
  await restartedAgain.check(true);
  assert.equal(terminalSuppressions, 2, "terminal suppressions and the recovered cursor must survive another restart");
});

test("GitHub gap-state migration compacts only proven terminal or consumed payloads and fails closed otherwise", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-gap-migration-"));
  const shaFor = (value) => value.toString(16).padStart(40, "0");
  const commits = Array.from({ length: 200 }, (_, index) => ({
    sha: shaFor(500 - index),
    commit: {
      message: `bounded migration evidence ${index} ${"m".repeat(400)}`,
      committer: { date: "2026-08-21T00:00:00.000Z" },
    },
    raw: "x".repeat(4_000),
  }));
  const terminalAnchor = "a".repeat(40);
  const consumedAnchor = "b".repeat(40);
  const activeAnchor = "c".repeat(40);
  const terminalRepository = "migration/terminal";
  const consumedRepository = "migration/consumed";
  const activeRepository = "migration/active";
  const unknownRepository = "migration/unknown";
  const corruptRepository = "migration/corrupt";
  const contradictoryRepository = "migration/contradictory";
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const terminalRecovery = {
    status: "anchor_not_found_via_unauthenticated_api",
    anchorFound: false,
    pages: 10,
    commits,
  };
  const recovered = {
    status: "anchor_recovered_via_unauthenticated_api",
    anchorFound: true,
    pages: 2,
    commits: [commits[0], { sha: consumedAnchor, commit: { message: "anchor" } }],
  };
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [terminalRepository]: {
      sha: terminalAnchor,
      gap: {
        status: "anchor_not_in_bounded_history",
        previousSha: terminalAnchor,
        newestSha: commits[0].sha,
        oldestFetchedSha: commits.at(-1).sha,
        fetchedCommits: commits.length,
        recovery: terminalRecovery,
      },
    },
    [consumedRepository]: {
      sha: commits[0].sha,
      gap: {
        status: "anchor_not_in_bounded_history",
        previousSha: consumedAnchor,
        newestSha: recovered.commits[0].sha,
        oldestFetchedSha: recovered.commits.at(-1).sha,
        fetchedCommits: recovered.commits.length,
        recovery: recovered,
      },
    },
    [activeRepository]: {
      sha: activeAnchor,
      gap: {
        status: "anchor_not_in_bounded_history",
        previousSha: activeAnchor,
        newestSha: recovered.commits[0].sha,
        oldestFetchedSha: recovered.commits.at(-1).sha,
        fetchedCommits: recovered.commits.length,
        recovery: recovered,
      },
    },
    [unknownRepository]: {
      sha: terminalAnchor,
      gap: {
        status: "anchor_not_in_bounded_history",
        previousSha: terminalAnchor,
        newestSha: commits[0].sha,
        oldestFetchedSha: commits.at(-1).sha,
        fetchedCommits: commits.length,
        recovery: { ...terminalRecovery, status: "future_recovery_state" },
      },
    },
    [corruptRepository]: {
      sha: terminalAnchor,
      gap: {
        status: "anchor_not_in_bounded_history",
        previousSha: terminalAnchor,
        newestSha: commits[0].sha,
        oldestFetchedSha: commits.at(-1).sha,
        fetchedCommits: 1,
        recovery: { ...terminalRecovery, commits: [{ raw: "missing sha" }] },
      },
    },
    [contradictoryRepository]: {
      sha: terminalAnchor,
      gap: {
        status: "anchor_not_in_bounded_history",
        previousSha: terminalAnchor,
        newestSha: "c".repeat(40),
        oldestFetchedSha: commits.at(-1).sha,
        fetchedCommits: 999,
        recovery: terminalRecovery,
      },
    },
  }));

  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [],
    now: () => new Date("2026-08-21T00:01:00.000Z"),
    sendAlertsImpl: async () => {},
  });
  await monitor.check(false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  const migratedTerminal = state[terminalRepository].gap.recovery;
  const migratedConsumed = state[consumedRepository].gap.recovery;
  assert.equal(migratedTerminal.commits, undefined);
  assert.equal(migratedTerminal.compactEvidence.classification, "terminal_anchor_not_found");
  assert.equal(migratedTerminal.compactEvidence.count, commits.length);
  assert.ok(Buffer.byteLength(JSON.stringify(migratedTerminal)) < 2_048);
  assert.equal(migratedConsumed.commits, undefined);
  assert.equal(migratedConsumed.compactEvidence.classification, "fully_consumed");
  assert.equal(state[activeRepository].gap.recovery.commits.length, 2, "a partially consumed recovery must remain resumable");
  assert.equal(state[unknownRepository].gap.recovery.commits.length, commits.length, "unknown lifecycle states must fail closed");
  assert.deepEqual(state[corruptRepository].gap.recovery.commits, [{ raw: "missing sha" }], "malformed evidence must fail closed");
  assert.equal(state[contradictoryRepository].gap.recovery.commits.length, commits.length, "contradictory range metadata must retain raw evidence");
});

test("GitHub state writes recover after a rejected queue operation without hiding that failure", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-write-queue-recovery-"));
  const repository = "flap-sh/flap-skills";
  let renames = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, text: async () => "<feed></feed>" }));
  const stateFs = {
    readFile: (...args) => fs.readFile(...args),
    mkdir: (...args) => fs.mkdir(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rm: (...args) => fs.rm(...args),
    rename: async (...args) => {
      renames += 1;
      if (renames === 1) throw new Error("injected rename failure");
      return fs.rename(...args);
    },
  };
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified", baselineOnly: true }],
    stateFs,
    sendAlertsImpl: async () => {},
  });
  await monitor.check(true);
  await assert.rejects(fs.readFile(path.join(dataDir, "github-state.json"), "utf8"), { code: "ENOENT" });
  await monitor.check(true);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(renames, 2);
  assert.equal(state._health.repositories[repository].status, "healthy");
});

test("regular GitHub repositories use bounded concurrency around a hanging source", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-regular-concurrency-"));
  let releaseBad;
  const badGate = new Promise((resolve) => { releaseBad = resolve; });
  const requested = [];
  const repositories = Array.from({ length: 5 }, (_, index) => ({ repository: `ordinary${index}/repo`, launchpad: `ordinary-${index}`, baselineOnly: true }));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    if (String(url).includes("/ordinary0/repo/")) await badGate;
    return { ok: true, status: 200, text: async () => "<feed></feed>" };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubPollConcurrency: 2 }, {
    autoStart: false,
    repositories,
    sendAlertsImpl: async () => {},
  });
  const checking = monitor.check(false);
  try {
    for (let attempt = 0; attempt < 30 && requested.length < repositories.length; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(requested.length, repositories.length);
  } finally {
    releaseBad();
  }
  await checking;
});

test("repository promotion waits for the same repository cursor lock", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-promotion-lock-"));
  const repository = "lockcase/repo";
  const alerts = [];
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  let atomCalls = 0;
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({ [repository]: { sha: "aaaa0001" } }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(".atom")) {
      atomCalls += 1;
      if (atomCalls === 1) await fetchGate;
      return {
        ok: true,
        status: 200,
        text: async () => `<feed>
          <entry><id>tag:github.com,2008:Grit::Commit/bbbb0002</id><updated>2026-08-06T00:00:02Z</updated><title>add v2 module</title></entry>
          <entry><id>tag:github.com,2008:Grit::Commit/aaaa0001</id><updated>2026-08-06T00:00:01Z</updated><title>old</title></entry>
        </feed>`,
      };
    }
    return { ok: true, status: 200, text: async () => "diff --git a/contracts/V2.sol b/contracts/V2.sol\n+++ b/contracts/V2.sol\n+ contract V2 {}" };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Candidate", sourceTrust: "configured_source" }],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
  });
  const regular = monitor.check(false);
  for (let attempt = 0; attempt < 20 && atomCalls === 0; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  let promotionSettled = false;
  const promotion = monitor.confirmOfficialRepository(repository, { source: "official_site", url: "https://lock.example" })
    .finally(() => { promotionSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(promotionSettled, false);
  releaseFetch();
  await Promise.all([regular, promotion]);
  await monitor.check(true);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, "bbbb0002");
  assert.equal(alerts.filter(({ type }) => type === "github_module_update").length, 1);
  assert.equal(state._repositories[repository].sourceTrust, "official_verified");
});

test("GitHub repository backoff survives restart and resumes from the stored commit cursor", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-repository-backoff-"));
  const repository = "flap-sh/flap-skills";
  const alerts = [];
  let currentTime = new Date("2026-08-06T00:00:00.000Z");
  let atomAttempts = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: "aaaa0001", checkedAt: "2026-08-05T23:59:00.000Z" },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(".atom")) {
      atomAttempts += 1;
      if (atomAttempts <= 2) return { ok: false, status: 503, headers: new Headers(), text: async () => "" };
      return {
        ok: true,
        status: 200,
        text: async () => `<feed>
          <entry><id>tag:github.com,2008:Grit::Commit/bbbb0002</id><updated>2026-08-06T00:00:01Z</updated><title>add v2 launch module</title></entry>
          <entry><id>tag:github.com,2008:Grit::Commit/aaaa0001</id><updated>2026-08-05T23:59:00Z</updated><title>previous</title></entry>
        </feed>`,
      };
    }
    if (String(url).includes(`/repos/${repository}/commits?`)) {
      return { ok: false, status: 503, headers: new Headers(), json: async () => [] };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "diff --git a/skills/flap/SKILL.md b/skills/flap/SKILL.md\nnew file mode 100644\n+++ b/skills/flap/SKILL.md\n+ v2 launch module",
    };
  });
  const options = {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", priority: true, sourceTrust: "official_verified" }],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date(currentTime),
    random: () => 0.5,
  };
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubRetryBaseMs: 1_000, githubRetryMaxMs: 8_000 }, options);
  await monitor.check(true);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, "aaaa0001");
  assert.equal(state._health.repositories[repository].status, "degraded");
  assert.equal(state._health.repositories[repository].consecutiveFailures, 1);
  assert.equal(state._health.repositories[repository].nextAttemptAt, "2026-08-06T00:00:01.000Z");

  const restarted = createGithubMonitor({ dataDir, githubToken: "", githubRetryBaseMs: 1_000, githubRetryMaxMs: 8_000 }, options);
  currentTime = new Date("2026-08-06T00:00:00.500Z");
  await restarted.check(true);
  assert.equal(atomAttempts, 1, "a persisted backoff must suppress the next 15-second scheduler tick");

  currentTime = new Date("2026-08-06T00:00:01.000Z");
  await restarted.check(true);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, "aaaa0001");
  assert.equal(state._health.repositories[repository].consecutiveFailures, 2);
  assert.equal(state._health.repositories[repository].backoffMs, 2_000);
  assert.equal(state._health.repositories[repository].nextAttemptAt, "2026-08-06T00:00:03.000Z");

  currentTime = new Date("2026-08-06T00:00:02.000Z");
  await restarted.check(true);
  assert.equal(atomAttempts, 2);

  currentTime = new Date("2026-08-06T00:00:03.000Z");
  await restarted.check(true);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, "bbbb0002");
  assert.equal(state[repository].coverage.status, "continuous");
  assert.equal(state._health.repositories[repository].status, "healthy");
  assert.equal(state._health.repositories[repository].consecutiveFailures, 0);
  assert.equal(state._health.repositories[repository].lastRecoveredAt, "2026-08-06T00:00:03.000Z");
  assert.deepEqual(alerts.map((event) => event.commit), ["bbbb0002"]);

  await restarted.check(true);
  assert.equal(atomAttempts, 4, "a successful priority repository remains eligible on every priority cycle");
  assert.equal(alerts.length, 1);
});

test("GitHub contract discovery failure retains the commit cursor for retry", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-contract-callback-retry-"));
  const repository = "flap-sh/flap-skills";
  const alerts = [];
  let callbackCalls = 0;
  let failCallback = true;
  let currentTime = new Date("2026-08-06T00:00:00.000Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({ [repository]: { sha: "aaaa0001" } }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith(".atom")) {
      return {
        ok: true,
        status: 200,
        text: async () => `<feed>
          <entry><id>tag:github.com,2008:Grit::Commit/bbbb0002</id><updated>2026-08-06T00:00:02Z</updated><title>deploy v2 factory</title></entry>
          <entry><id>tag:github.com,2008:Grit::Commit/aaaa0001</id><updated>2026-08-06T00:00:01Z</updated><title>old</title></entry>
        </feed>`,
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => "diff --git a/contracts/V2.sol b/contracts/V2.sol\nnew file mode 100644\n+++ b/contracts/V2.sol\n+ BSC mainnet Factory: 0x1111111111111111111111111111111111111111",
    };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubRetryBaseMs: 1_000, githubRetryMaxMs: 8_000 }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified" }],
    now: () => new Date(currentTime),
    random: () => 0.5,
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    onContractDiscovery: async () => {
      callbackCalls += 1;
      if (failCallback) throw new Error("registry unavailable");
    },
  });
  await monitor.check(true);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, "aaaa0001");
  assert.equal(state._health.repositories[repository].status, "degraded");
  assert.equal(callbackCalls, 1);

  failCallback = false;
  currentTime = new Date("2026-08-06T00:00:01.000Z");
  await monitor.check(true);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state[repository].sha, "bbbb0002");
  assert.equal(state._health.repositories[repository].status, "healthy");
  assert.equal(callbackCalls, 2);
  assert.equal(alerts.filter(({ type }) => type === "github_module_update").length, 2);
});

test("official pull request monitoring baselines silently then alerts once on a structural Flap feature", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-flap-"));
  const repository = "flap-sh/FlapVaultExample";
  const alerts = [];
  let currentTime = new Date("2026-08-06T18:40:00.000Z");
  let pullRequests = [{
    number: 7,
    title: "existing pull request",
    body: "",
    state: "open",
    draft: false,
    html_url: `https://github.com/${repository}/pull/7`,
    created_at: "2026-08-05T00:00:00Z",
    updated_at: "2026-08-05T00:00:00Z",
    head: { sha: "aaaa0007" },
    user: { login: "flap-dev" },
  }];
  let fileRequests = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/repos/${repository}/pulls`) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => pullRequests };
    }
    if (parsed.pathname === `/repos/${repository}/pulls/8/files`) {
      fileRequests += 1;
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [
          { filename: "src/VaultBaseV3.sol", status: "added", additions: 180, deletions: 0, patch: "+contract VaultBaseV3 { function vaultQuoteToken() external {} }" },
          { filename: "src/FreeCoinV3Beacon.sol", status: "added", additions: 40, deletions: 0, patch: "+contract FreeCoinV3Beacon {}" },
        ],
      };
    }
    throw new Error(`unexpected GitHub PR request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubPrPollIntervalMs: 1_000 }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified", priority: true }],
    pullRequestRepositories: [repository],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date(currentTime),
  });

  await monitor.checkPullRequests();
  assert.equal(alerts.length, 0);
  assert.equal(fileRequests, 0, "the first observation must be a low-cost silent baseline");

  pullRequests = [{
    number: 8,
    title: "feat: VaultBaseV3 spec for ERC20 quote vaults + quote-agnostic reference",
    body: "Adds ERC20 quote token support to the official vault factory specification.",
    state: "open",
    draft: true,
    html_url: `https://github.com/${repository}/pull/8`,
    created_at: "2026-08-06T18:48:40Z",
    updated_at: "2026-08-06T18:50:00Z",
    head: { sha: "bbbb0008" },
    user: { login: "flap-dev" },
    author_association: "MEMBER",
  }, ...pullRequests];
  currentTime = new Date("2026-08-06T18:50:00.000Z");
  await monitor.checkPullRequests();
  assert.equal(fileRequests, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "github_module_update");
  assert.equal(alerts[0].developmentStage, "pull_request");
  assert.equal(alerts[0].pullRequest.number, 8);
  assert.equal(alerts[0].pullRequest.draft, true);
  assert.equal(alerts[0].modeChange.candidate, true);
  assert.equal(alerts[0].sourceTrust, "official_verified");
  assert.equal(alerts[0].onchainConfirmed, false);
  assert.equal(alerts[0].authorAssociation, "MEMBER");
  assert.equal(alerts[0].pullRequest.authorAssociation, "MEMBER");
  assert.equal(alerts[0].githubChange.scheme, "github_change_v1");
  assert.equal(alerts[0].githubChange.stage, "pull_request");
  assert.equal(alerts[0].githubChange.basis, "pull_request_snapshot");
  assert.deepEqual(alerts[0].changeEvidence, alerts[0].githubChange.facts);

  currentTime = new Date("2026-08-06T19:00:00.000Z");
  await monitor.checkPullRequests();
  assert.equal(fileRequests, 1, "review activity without a new head commit must not refetch or alert");
  assert.equal(alerts.length, 1);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._pullRequests.effectivePollIntervalMs, 600_000);
  assert.equal(state._pullRequests.repositories[repository.toLowerCase()].pullRequests["8"].actionable, true);
});

test("Binance skill PR events persist author, semantic GitHub summary, and Binance classification", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-binance-semantic-"));
  const repository = "binance/binance-skills-hub";
  const alerts = [];
  let initialized = false;
  let currentTime = new Date("2026-08-20T10:01:00Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/repos/${repository}/pulls`) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => initialized ? [{
          number: 307,
          title: "Add aiko: multi-signal decision-fusion skill",
          body: "Adds a production Binance Web3 skill that fuses independent market signals.",
          state: "open",
          draft: false,
          html_url: `https://github.com/${repository}/pull/307`,
          created_at: "2026-08-20T09:58:00Z",
          updated_at: "2026-08-20T10:00:00Z",
          head: { sha: "23e6000000000000000000000000000000000307" },
          user: { login: "binance-dev" },
          author_association: "MEMBER",
        }] : [],
      };
    }
    if (parsed.pathname === `/repos/${repository}/pulls/307/files`) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [{
          filename: "skills/binance-web3/aiko/SKILL.md",
          status: "added",
          additions: 90,
          deletions: 0,
          patch: "+---\n+name: aiko\n+description: Multi-signal decision-fusion for Binance Web3\n+---\n+# Aiko",
        }, {
          filename: "skills/binance-web3/aiko/scripts/cli.mjs",
          status: "added",
          additions: 40,
          deletions: 0,
          patch: "+export function parseSignals() {",
        }],
      };
    }
    throw new Error(`unexpected Binance PR request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubPrPollIntervalMs: 1_000 }, {
    autoStart: false,
    repositories: [{
      repository,
      launchpad: "Binance Wallet",
      sourceTrust: "official_verified",
      baselineOnly: true,
      officialEvidence: { source: "official_binance_github", url: "https://github.com/binance" },
    }],
    pullRequestRepositories: [repository],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date(currentTime),
  });

  await monitor.checkPullRequests();
  initialized = true;
  currentTime = new Date("2026-08-20T10:11:00Z");
  await monitor.checkPullRequests();

  assert.equal(alerts.length, 1);
  const [event] = alerts;
  assert.equal(event.authorAssociation, "MEMBER");
  assert.equal(event.githubChange.scheme, "github_change_v1");
  assert.equal(event.githubChange.basis, "pull_request_snapshot");
  assert.equal(event.githubChange.primaryFact.subject, "skill:aiko");
  assert.match(event.githubChange.primaryFact.after, /Multi-signal decision-fusion/i);
  assert.equal(event.binanceChange.scheme, "binance_github_diff_v1");
  assert.equal(event.binanceChange.substantive, true);
  assert.equal(event.binanceChange.productFeature, true);
  assert.equal(event.binanceOfficial, true);
  assert.equal(event.strong, true);
  assert.deepEqual(event.changeEvidence, event.githubChange.facts);
});

test("pull request file pagination reaches a semantic production fact on page two without claiming a partial diff", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-file-pagination-"));
  const repository = "binance/binance-skills-hub";
  const alerts = [];
  const requestedPages = [];
  let initialized = false;
  let currentTime = new Date("2026-08-20T11:00:00Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/repos/${repository}/pulls`) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => initialized ? [{
          number: 309,
          title: "Add onchain-pay-action-ref-verify skill",
          body: "Verifies action_ref against an on-chain anchor.",
          state: "open",
          head: { sha: "8b40000000000000000000000000000000000309" },
          user: { login: "binance-dev" },
          author_association: "CONTRIBUTOR",
        }] : [],
      };
    }
    if (parsed.pathname === `/repos/${repository}/pulls/309/files`) {
      const page = Number(parsed.searchParams.get("page"));
      requestedPages.push(page);
      if (page === 1) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => Array.from({ length: 100 }, (_, index) => ({
            filename: `snapshots/generated-${index}.json`,
            status: "modified",
            patch: `-\"value\": ${index},\n+\"value\": ${index + 1},`,
          })),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => page === 2 ? [{
          filename: "skills/binance/onchain-pay-action-ref-verify/SKILL.md",
          status: "added",
          patch: "+---\n+name: onchain-pay-action-ref-verify\n+description: |\n+  Derives and verifies action_ref, then checks an on-chain anchor. Read-only.\n+---",
        }] : [],
      };
    }
    throw new Error(`unexpected paged PR request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubPrPollIntervalMs: 1_000 }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Binance", sourceTrust: "official_verified" }],
    pullRequestRepositories: [repository],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date(currentTime),
  });

  await monitor.checkPullRequests();
  initialized = true;
  currentTime = new Date("2026-08-20T11:10:00Z");
  await monitor.checkPullRequests();

  assert.deepEqual(requestedPages, [1, 2]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].githubChange.completeness, "complete");
  assert.equal(alerts[0].githubChange.primaryFact.subject, "skill:onchain-pay-action-ref-verify");
  assert.equal(alerts[0].files.length, 101);
});

test("official Flap pull request contracts register BSC discovery and retry the PR cursor after callback failure", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-contract-discovery-"));
  const repository = "flap-sh/FlapVaultExample";
  const address = "0x1111111111111111111111111111111111111111";
  const alerts = [];
  const discoveries = [];
  let currentTime = new Date("2026-08-08T04:00:00.000Z");
  let pullRequests = [];
  let failDiscovery = true;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/repos/${repository}/pulls`) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => pullRequests };
    }
    if (parsed.pathname === `/repos/${repository}/pulls/9/files`) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [{
          filename: "deployments/bsc/factory.json",
          status: "added",
          additions: 1,
          deletions: 0,
          patch: `+{ "chainId": 56, "factory": "${address}" }`,
        }],
      };
    }
    throw new Error(`unexpected GitHub PR request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubPrPollIntervalMs: 1_000 }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified", priority: true }],
    pullRequestRepositories: [repository],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    onContractDiscovery: async (signal) => {
      discoveries.push(signal);
      if (failDiscovery) throw new Error("BSC registry unavailable");
    },
    now: () => new Date(currentTime),
  });

  await monitor.checkPullRequests();
  pullRequests = [{
    number: 9,
    title: "feat: deploy BSC mainnet factory",
    body: "Official Flap factory deployment on BNB Chain (chainId 56).",
    state: "open",
    draft: false,
    html_url: `https://github.com/${repository}/pull/9`,
    created_at: "2026-08-08T04:09:00Z",
    updated_at: "2026-08-08T04:10:00Z",
    head: { sha: "bbbb0009" },
    user: { login: "flap-dev" },
  }];
  currentTime = new Date("2026-08-08T04:10:00.000Z");
  await monitor.checkPullRequests();

  let state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  const key = repository.toLowerCase();
  assert.equal(state._pullRequests.repositories[key].status, "degraded");
  assert.equal(state._pullRequests.repositories[key].pullRequests["9"], undefined, "failed discovery must not consume the PR revision");
  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0].chainId, 56);
  assert.equal(discoveries[0].sourceTrust, "official_verified");
  assert.deepEqual(discoveries[0].addresses, [address]);

  failDiscovery = false;
  currentTime = new Date("2026-08-08T04:11:00.000Z");
  await monitor.checkPullRequests();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._pullRequests.repositories[key].status, "healthy");
  assert.equal(state._pullRequests.repositories[key].pullRequests["9"].actionable, true);
  assert.equal(discoveries.length, 2);
  assert.equal(alerts.length, 2, "the PR event is reprocessed until discovery registration succeeds");
});

test("default-branch monitoring marks a Flap chain deployment as a strong structural change", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-chain-commit-"));
  const repository = "flap-sh/FlapVaultExample";
  const alerts = [];
  let latest = "aaaa1001";
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const value = String(url);
    if (value.endsWith(".atom")) {
      const previous = latest === "bbbb1002"
        ? "<entry><id>tag:github.com,2008:Grit::Commit/aaaa1001</id><updated>2026-08-08T00:00:00Z</updated><title>baseline</title></entry>"
        : "";
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/${latest}</id><updated>2026-08-08T00:01:00Z</updated><title>${latest === "bbbb1002" ? "feat: deploy Base mainnet" : "baseline"}</title></entry>${previous}</feed>`,
      };
    }
    if (value.endsWith("/commit/bbbb1002.patch")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => "diff --git a/deployments/base/addresses.json b/deployments/base/addresses.json\nnew file mode 100644\n--- /dev/null\n+++ b/deployments/base/addresses.json\n+{ \\\"chainId\\\": 8453, \\\"factory\\\": \\\"0x1111111111111111111111111111111111111111\\\" }",
      };
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified", priority: true, baselineOnly: true }],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date("2026-08-08T00:02:00Z"),
  });

  await monitor.check(true);
  assert.equal(alerts.length, 0);
  latest = "bbbb1002";
  await monitor.check(true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].strong, true);
  assert.equal(alerts[0].modeChange.reason, "new_chain_support");
  assert.equal(alerts[0].chainSupportChange.candidate, true);
  assert.equal(alerts[0].chainSupportChange.stage, "commit");
  assert.deepEqual(alerts[0].chainSupportChange.chains.map(({ name, chainId, environment }) => ({ name, chainId, environment })), [
    { name: "Base", chainId: 8453, environment: "mainnet" },
  ]);
  assert.match(alerts[0].chainSupportChange.chains[0].evidence, /Base mainnet|chainId/);
});

test("Uniswap chain commits use the detected chain and route only BNB contracts into BSC discovery", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-uniswap-chain-routing-"));
  const repository = "Uniswap/deployments";
  const alerts = [];
  const discoveries = [];
  let latest = "bbbb2002";
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: "aaaa2001" },
    _repositories: {
      [repository]: { repository, launchpad: "Uniswap", sourceTrust: "official_verified", uniswapOfficial: true, chainId: 4663 },
    },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const value = String(url);
    if (value.endsWith(".atom")) {
      const anchor = latest === "bbbb2002"
        ? '<entry><id>tag:github.com,2008:Grit::Commit/aaaa2001</id><updated>2026-08-08T02:00:00Z</updated><title>old</title></entry>'
        : '<entry><id>tag:github.com,2008:Grit::Commit/bbbb2002</id><updated>2026-08-08T02:01:00Z</updated><title>BNB deployment</title></entry>';
      const title = latest === "bbbb2002" ? "feat: deploy BNB Chain mainnet" : "feat: deploy Base mainnet";
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/${latest}</id><updated>2026-08-08T02:02:00Z</updated><title>${title}</title></entry>${anchor}</feed>`,
      };
    }
    if (value.endsWith("/commit/bbbb2002.patch")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => "diff --git a/networks/bsc-mainnet.json b/networks/bsc-mainnet.json\nnew file mode 100644\n+++ b/networks/bsc-mainnet.json\n+ BNB Chain mainnet chainId: 56 Factory: 0x1111111111111111111111111111111111111111",
      };
    }
    if (value.endsWith("/commit/cccc2003.patch")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => "diff --git a/networks/base-mainnet.json b/networks/base-mainnet.json\nnew file mode 100644\n+++ b/networks/base-mainnet.json\n+ Base mainnet chainId: 8453 Factory: 0x2222222222222222222222222222222222222222",
      };
    }
    throw new Error(`unexpected GitHub request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", monitorScope: "focus3", ponsMonitorEnabled: false }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Uniswap", sourceTrust: "official_verified", uniswapOfficial: true, baselineOnly: true }],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    onContractDiscovery: async (signal) => discoveries.push(signal),
    now: () => new Date("2026-08-08T02:03:00Z"),
  });

  await monitor.check(false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].chainId, 56);
  assert.equal(alerts[0].environment, "mainnet");
  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0].chainId, 56);

  latest = "cccc2003";
  await monitor.check(false);
  assert.equal(alerts.length, 2);
  assert.equal(alerts[1].chainId, 8453);
  assert.equal(alerts[1].environment, "mainnet");
  assert.equal(discoveries.length, 1, "a Base deployment must not be registered in the BSC discovery monitor");
  assert.equal(alerts.some((event) => event.chainId === 4663), false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(Object.hasOwn(state._repositories[repository], "chainId"), false);
});

test("pull-request monitoring emits Uniswap cross-chain deployment code but ignores README-only claims", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-chain-pr-"));
  const repository = "Uniswap/liquidity-launcher";
  const alerts = [];
  let initialized = false;
  let currentTime = new Date("2026-08-08T01:00:00Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/repos/${repository}/pulls`) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => initialized ? [
          { number: 32, title: "docs: Base support", body: "Now available on Base.", state: "open", head: { sha: "cccc0032" }, user: { login: "uni-docs" } },
          { number: 31, title: "feat: add Base mainnet chain deployment", body: "Deploy launcher contracts on chainId 8453.", state: "open", head: { sha: "bbbb0031" }, user: { login: "uni-dev" } },
        ] : [],
      };
    }
    if (parsed.pathname.endsWith("/pulls/32/files")) {
      return { ok: true, status: 200, headers: new Headers(), json: async () => [{ filename: "README.md", status: "modified", patch: "+Now available on Base mainnet, chainId 8453." }] };
    }
    if (parsed.pathname.endsWith("/pulls/31/files")) {
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => [{ filename: "deployments/base/Launcher.json", status: "added", patch: "+{ \"chainId\": 8453, \"launcher\": \"0x2222222222222222222222222222222222222222\" }" }],
      };
    }
    throw new Error(`unexpected GitHub PR request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubPrPollIntervalMs: 1_000 }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Uniswap / Pools.trade", sourceTrust: "official_verified", priority: true, uniswapOfficial: true }],
    pullRequestRepositories: [repository],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date(currentTime),
  });

  await monitor.checkPullRequests();
  initialized = true;
  currentTime = new Date("2026-08-08T01:10:00Z");
  await monitor.checkPullRequests();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].pullRequest.number, 31);
  assert.equal(alerts[0].strong, true);
  assert.equal(alerts[0].modeChange.reason, "new_chain_support");
  assert.equal(alerts[0].chainSupportChange.stage, "pr");
  assert.equal(alerts[0].chainId, 8453);
  assert.equal(alerts[0].environment, "mainnet");
  assert.deepEqual(alerts[0].chainSupportChange.chains.map(({ name, chainId, environment }) => ({ name, chainId, environment })), [
    { name: "Base", chainId: 8453, environment: "mainnet" },
  ]);
});

test("official pull request monitoring filters image-link noise and Uniswap equity issuance", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-noise-"));
  const fourRepository = "four-meme-community/openfour-docs";
  const uniswapRepository = "Uniswap/liquidity-launcher";
  const alerts = [];
  let currentTime = new Date("2026-08-07T00:00:00.000Z");
  let initialized = false;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === `/repos/${fourRepository}/pulls`) {
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => initialized ? [{ number: 11, title: "fix: secure remote image URL", body: "Regression test for an external image link.", state: "open", head: { sha: "four0011" }, user: { login: "four-dev" } }] : [],
      };
    }
    if (parsed.pathname === `/repos/${uniswapRepository}/pulls`) {
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => initialized ? [
          { number: 22, title: "feat: add CrowdLaunchStrategy", body: "New token launch auction strategy", state: "open", head: { sha: "uni0022" }, user: { login: "uni-dev" } },
          { number: 23, title: "docs: add LP fee flow guide for searchers and keepers", body: "Documents the existing flow.", state: "open", head: { sha: "uni0023" }, user: { login: "uni-docs" } },
          { number: 21, title: "feat: add equity launch hook", body: "Tokenized stock issuance", state: "open", head: { sha: "uni0021" }, user: { login: "uni-dev" } },
        ] : [],
      };
    }
    if (parsed.pathname.endsWith("/pulls/11/files")) return { ok: true, status: 200, headers: new Headers(), json: async () => [{ filename: "docs/security.md", status: "modified", additions: 2, deletions: 2, patch: "+replace external image URL" }] };
    if (parsed.pathname.endsWith("/pulls/21/files")) return { ok: true, status: 200, headers: new Headers(), json: async () => [{ filename: "src/strategies/EquityLaunchHook.sol", status: "added", additions: 80, deletions: 0, patch: "+// tokenized stock issuance" }] };
    if (parsed.pathname.endsWith("/pulls/22/files")) return { ok: true, status: 200, headers: new Headers(), json: async () => [{ filename: "src/strategies/CrowdLaunchStrategy.sol", status: "added", additions: 120, deletions: 0, patch: "+contract CrowdLaunchStrategy {}" }] };
    if (parsed.pathname.endsWith("/pulls/23/files")) return { ok: true, status: 200, headers: new Headers(), json: async () => [{ filename: "docs/TechnicalReference.md", status: "modified", additions: 74, deletions: 0, patch: "+LP fee flow for searchers and keepers" }] };
    throw new Error(`unexpected GitHub PR request: ${url}`);
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubPrPollIntervalMs: 1_000 }, {
    autoStart: false,
    repositories: [
      { repository: fourRepository, launchpad: "Four.meme", sourceTrust: "official_verified", priority: true },
      { repository: uniswapRepository, launchpad: "Uniswap / Pools.trade", sourceTrust: "official_verified", priority: true, uniswapOfficial: true },
    ],
    pullRequestRepositories: [fourRepository, uniswapRepository],
    sendAlertsImpl: async (_config, event) => alerts.push(event),
    now: () => new Date(currentTime),
  });
  await monitor.checkPullRequests();
  initialized = true;
  currentTime = new Date("2026-08-07T00:10:00.000Z");
  await monitor.checkPullRequests();
  assert.deepEqual(alerts.map((event) => event.pullRequest.number), [22]);
  assert.equal(alerts[0].uniswapOfficial, true);
  assert.equal(alerts[0].strong, true);
});

test("startup probes persisted focus3 transport backoff once but preserves GitHub rate-limit backoff", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-startup-transport-probe-"));
  const transportRepository = "flap-sh/flap-skills";
  const rateLimitedRepository = "four-meme-community/openfour-docs";
  const currentTime = new Date("2026-08-08T00:00:00.000Z");
  const future = "2026-08-08T01:00:00.000Z";
  const requested = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [transportRepository]: { sha: "aaaa0001" },
    [rateLimitedRepository]: { sha: "bbbb0001" },
    _health: {
      repositories: {
        [transportRepository]: { status: "degraded", lastError: "fetch failed: EADDRNOTAVAIL", lastErrorStatus: null, consecutiveFailures: 5, nextAttemptAt: future },
        [rateLimitedRepository]: { status: "degraded", lastError: "GitHub returned HTTP 429", lastErrorStatus: 429, consecutiveFailures: 5, nextAttemptAt: future },
      },
    },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/aaaa0001</id><updated>2026-08-07T23:59:00Z</updated><title>anchor</title></entry></feed>`,
    };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [
      { repository: transportRepository, launchpad: "Flap", sourceTrust: "official_verified", priority: true },
      { repository: rateLimitedRepository, launchpad: "Four.meme", sourceTrust: "official_verified", priority: true },
    ],
    sendAlertsImpl: async () => {},
    now: () => new Date(currentTime),
  });
  await monitor.check(true);
  assert.equal(requested.some((url) => url.includes(transportRepository)), true);
  assert.equal(requested.some((url) => url.includes(rateLimitedRepository)), false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._health.repositories[transportRepository].status, "healthy");
  assert.equal(state._health.repositories[rateLimitedRepository].nextAttemptAt, future);
});

test("GitHub transport retry backoff is capped at sixty seconds", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-transport-cap-"));
  const repository = "flap-sh/flap-skills";
  const currentTime = new Date("2026-08-08T00:00:00.000Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha: "aaaa0001" },
    _health: { repositories: { [repository]: { status: "degraded", lastError: "fetch failed", consecutiveFailures: 8, nextAttemptAt: "2026-08-07T23:59:00.000Z" } } },
  }));
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed", { cause: { code: "EADDRNOTAVAIL" } }); });
  const monitor = createGithubMonitor({ dataDir, githubToken: "", githubRetryBaseMs: 60_000, githubRetryMaxMs: 3_600_000 }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified", priority: true }],
    sendAlertsImpl: async () => {},
    now: () => new Date(currentTime),
    random: () => 1,
  });
  await monitor.check(true);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._health.repositories[repository].backoffMs, 60_000);
  assert.equal(state._health.repositories[repository].nextAttemptAt, "2026-08-08T00:01:00.000Z");
});

test("pull request startup probes transport backoff once but preserves GitHub rate-limit policy", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-startup-transport-"));
  const transportRepository = "flap-sh/FlapVaultExample";
  const rateLimitedRepository = "four-meme-community/openfour-docs";
  const currentTime = new Date("2026-08-08T00:00:00.000Z");
  const future = "2026-08-08T01:00:00.000Z";
  const requested = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    _pullRequests: {
      repositories: {
        [transportRepository.toLowerCase()]: { initializedAt: "2026-08-07T00:00:00Z", pullRequests: {}, lastError: "fetch failed: ECONNRESET", lastErrorStatus: null, consecutiveFailures: 4, nextAttemptAt: future },
        [rateLimitedRepository]: { initializedAt: "2026-08-07T00:00:00Z", pullRequests: {}, lastError: "GitHub returned HTTP 429", lastErrorStatus: 429, consecutiveFailures: 4, nextAttemptAt: future },
      },
    },
  }));
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(String(url));
    return { ok: true, status: 200, headers: new Headers(), json: async () => [] };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [
      { repository: transportRepository, launchpad: "Flap", sourceTrust: "official_verified", priority: true },
      { repository: rateLimitedRepository, launchpad: "Four.meme", sourceTrust: "official_verified", priority: true },
    ],
    pullRequestRepositories: [transportRepository, rateLimitedRepository],
    sendAlertsImpl: async () => {},
    now: () => new Date(currentTime),
  });
  await monitor.checkPullRequests();
  assert.equal(requested.some((url) => url.includes(transportRepository)), true);
  assert.equal(requested.some((url) => url.includes(rateLimitedRepository)), false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._pullRequests.repositories[transportRepository.toLowerCase()].status, "healthy");
  assert.equal(state._pullRequests.repositories[rateLimitedRepository].nextAttemptAt, future);
});

test("pull request transport retry backoff is capped at sixty seconds", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-pr-transport-cap-"));
  const repository = "flap-sh/FlapVaultExample";
  const key = repository.toLowerCase();
  const currentTime = new Date("2026-08-08T00:00:00.000Z");
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => {});
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    _pullRequests: { repositories: { [key]: { initializedAt: "2026-08-07T00:00:00Z", pullRequests: {}, lastError: "fetch failed", consecutiveFailures: 8, nextAttemptAt: "2026-08-07T23:59:00.000Z" } } },
  }));
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }); });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "Flap", sourceTrust: "official_verified", priority: true }],
    pullRequestRepositories: [repository],
    sendAlertsImpl: async () => {},
    now: () => new Date(currentTime),
  });
  await monitor.checkPullRequests();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(state._pullRequests.repositories[key].backoffMs, 60_000);
  assert.equal(state._pullRequests.repositories[key].nextAttemptAt, "2026-08-08T00:01:00.000Z");
});

test("GitHub stop is idempotent and drains an in-flight lane through its state checkpoint", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-stop-drain-"));
  const repository = "example/stop-drain";
  const sha = "a".repeat(40);
  t.after(() => {
    PRIORITY_REPOSITORIES.delete(repository);
    return fs.rm(dataDir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dataDir, "github-state.json"), JSON.stringify({
    [repository]: { sha },
  }));
  let requests = 0;
  let releaseFetch;
  const fetchBlocked = new Promise((resolve) => { releaseFetch = resolve; });
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    markFetchStarted();
    await fetchBlocked;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => `<feed><entry><id>tag:github.com,2008:Grit::Commit/${sha}</id><title>unchanged</title></entry></feed>`,
    };
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "" }, {
    autoStart: false,
    repositories: [{ repository, launchpad: "test", priority: true, baselineOnly: true }],
    sendAlertsImpl: async () => {},
  });

  const checking = monitor.check(true);
  await fetchStarted;
  const stopping = monitor.stop();
  assert.equal(monitor.stop(), stopping, "repeated stops share one drain boundary");
  assert.equal(monitor.check(true), checking, "post-stop checks cannot start a new GitHub round");
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  releaseFetch();
  await stopping;
  assert.equal(requests, 1);
  const durable = JSON.parse(await fs.readFile(path.join(dataDir, "github-state.json"), "utf8"));
  assert.equal(durable._health.repositories[repository].status, "healthy");
});

test("GitHub stop rejects late cross-lane discovery and verification without fetch, write, or alert", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-stop-external-gate-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let requests = 0;
  let alerts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new Error("post-stop GitHub fetch must not run");
  });
  const monitor = createGithubMonitor({ dataDir, githubToken: "test-token" }, {
    autoStart: false,
    repositories: [],
    sendAlertsImpl: async () => { alerts += 1; },
  });

  await monitor.stop();
  assert.deepEqual(await monitor.discoverByContract("0x1111111111111111111111111111111111111111", "Flap"), []);
  assert.equal(await monitor.confirmOfficialRepository("example/late", {
    source: "official_site",
    url: "https://late.example",
  }), null);
  assert.equal(requests, 0);
  assert.equal(alerts, 0);
  await assert.rejects(fs.access(path.join(dataDir, "github-state.json")), { code: "ENOENT" });
});
