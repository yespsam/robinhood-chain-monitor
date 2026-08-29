import test from "node:test";
import assert from "node:assert/strict";

import { buildBilingualAlertBundle } from "../src/bilingual-alert-renderer.js";
import { clearTranslationCache, translateAlertLines } from "../src/chinese-localizer.js";

function googleResponse(translated) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify([[[translated, "source"]], null, "auto"]),
  };
}

function googleStub(transform) {
  return async (url) => {
    const parsed = new URL(url);
    return googleResponse(transform({
      source: parsed.searchParams.get("q") || "",
      target: parsed.searchParams.get("tl"),
    }));
  };
}

test("canonical English terminology overrides literal public-provider mistranslations", async () => {
  clearTranslationCache();
  const fetchImpl = googleStub(({ source, target }) => {
    if (target !== "en") return source;
    return source
      .replaceAll("官方能力更新", "Official ability update")
      .replaceAll("具体更新", "Specific update")
      .replaceAll("新底池", "New pot")
      .replaceAll("新增官方", "Added official")
      .replaceAll("仓库", "warehouse")
      .replaceAll("发射台", "transmitter")
      .replaceAll("已启用", "enabled");
  });

  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: fetchImpl,
    alertTranslationTimeoutMs: 500,
  }, {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap" },
  }, [
    "🧩 Flap 官方能力更新",
    "具体更新: 新底池",
    "仓库: 新增官方仓库",
    "发射台: 已启用",
  ].join("\n"));

  assert.equal(bundle.en.text.split("\n")[0], "Platform: Flap");
  assert.match(bundle.changeModel.after.text, /新底池/);
  assert.match(bundle.en.text, /new pool/i);
  assert.doesNotMatch(bundle.en.text, /Translation unavailable|see Chinese block/i);
  assert.doesNotMatch(bundle.en.text, /\b(?:official ability update|new pot|warehouse|transmitter)\b/i);
});

test("the Chinese block removes a duplicated slash NEW POOL label", async () => {
  clearTranslationCache();
  const address = "0x1111111111111111111111111111111111111111";
  const fetchImpl = googleStub(({ source, target }) => target === "en"
    ? source
      .replaceAll("官方能力更新", "Official capability update")
      .replaceAll("具体更新", "Update")
      .replaceAll("新底池", "New pool")
    : source);

  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: fetchImpl,
    alertTranslationTimeoutMs: 500,
  }, {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap" },
    factory: address,
  }, [
    "🧩 Flap 官方能力更新",
    `具体更新: 新底池 / NEW POOL: INDEX · Factory ${address}`,
  ].join("\n"));

  assert.match(bundle.zh.text, /新底池/);
  assert.doesNotMatch(bundle.zh.text, /\/\s*NEW\s+POOL\b/i);
  assert.equal((bundle.zh.text.match(/新底池/g) || []).length, 1);
  assert.match(bundle.zh.text, new RegExp(address));
});

test("a structured platform diff outranks generic source-only capability prose", async () => {
  clearTranslationCache();
  const factory = "0x1212121212121212121212121212121212121212";
  const quote = "0x3434343434343434343434343434343434343434";
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: googleStub(({ source }) => source),
    alertTranslationTimeoutMs: 500,
  }, {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap" },
    changes: {
      newFlapPools: [{ category: "QUOTE", vaultFactory: factory, quoteAddress: quote }],
    },
  }, [
    "🧩 Flap 官方能力更新",
    "具体更新: 页面摘要发生变化",
  ].join("\n"));

  assert.match(bundle.zh.text, /更新了什么：新增发币报价资产；可作为新币定价与结算币种/);
  assert.match(bundle.zh.text, new RegExp(factory));
  assert.match(bundle.zh.text, new RegExp(quote));
  assert.doesNotMatch(bundle.zh.text, /页面摘要发生变化/);
});

test("source-only platform fallback replaces the unresolved placeholder and mirrors source time", async () => {
  clearTranslationCache();
  const factory = "0x5656565656565656565656565656565656565656";
  const observedAt = "2026-08-18T01:02:03.000Z";
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    alertTranslationTimeoutMs: 50,
  }, {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap" },
    factory,
    observedAt,
  }, [
    "🧩 Flap 官方能力更新",
    `具体更新: 新底池 / NEW POOL: INDEX · Factory ${factory}`,
    "状态: 官方页面已记录；链上部署/实际启用尚未确认",
    "时间: 2026-08-18 17:30:00 · 延迟7秒",
  ].join("\n"));

  assert.deepEqual(bundle.changeModel.after.items, [`新底池 / NEW POOL: INDEX · Factory ${factory}`]);
  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.equal(block.split("\n").length, 2, "the compact card must keep exactly two fields per language");
    assert.equal((block.match(/Factory/g) || []).length, 1, "Factory evidence must appear exactly once per language");
    assert.doesNotMatch(block, /能力快照变化|Capability snapshot changed|字段尚未解析|exact field unresolved/i);
    assert.match(block, /2026-08-18 17:30:00/);
    assert.equal((block.match(/2026-08-18 17:30:00/g) || []).length, 1, "source timestamp must be mirrored once per language");
    assert.doesNotMatch(block, new RegExp(observedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(bundle.zh.text, /延迟7秒/);
  assert.match(bundle.en.text, /7s delay/i);
  assert.match(bundle.en.text, /Official source recorded it/i);
});

test("one failed line-level provider request does not discard translations for other lines", async () => {
  clearTranslationCache();
  let calls = 0;
  const successfulLine = "Add a new liquidity pool";
  const failingLine = "This sentence deliberately fails translation";
  const result = await translateAlertLines([successfulLine, failingLine], {
    targetLanguage: "zh-CN",
    timeoutMs: 500,
    fetchImpl: async (url) => {
      calls += 1;
      const source = new URL(url).searchParams.get("q") || "";
      if (source.includes(failingLine)) {
        return { ok: false, status: 503, text: async () => "unavailable" };
      }
      return googleResponse(source.replaceAll(successfulLine, "新增流动性池"));
    },
  });

  assert.ok(calls >= 2, "each translatable line should be isolated from failures in another line");
  assert.match(result.lines[0], /新增流动性池/);
  assert.match(result.lines[1], /This sentence deliberately fails translation|翻译暂不可用/);
});

test("long English lines truncate only at a complete source-word boundary", async () => {
  clearTranslationCache();
  const source = `Update: X ${"alpha ".repeat(50).trim()}`;
  const sourceWords = new Set(source.match(/[A-Za-z]+/g) || []);
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: googleStub(({ source: translatedSource, target }) => target === "zh-CN"
      ? `这是一个长更新 ${translatedSource}`
      : translatedSource),
    alertTranslationTimeoutMs: 500,
  }, { type: "twitter_update" }, source);

  assert.ok(bundle.en.text.split("\n").every((line) => line.length <= 230));
  for (const match of bundle.en.text.matchAll(/([A-Za-z]+)…/g)) {
    assert.ok(sourceWords.has(match[1]), `ellipsis split the source word at ${match[1]}…`);
  }
});

test("addresses, repository basenames, and function names remain byte-for-byte complete", async () => {
  clearTranslationCache();
  const address = "0x2222222222222222222222222222222222222222";
  const repository = "Uniswap/continuous-clearing-auction";
  const repositoryName = "continuous-clearing-auction";
  const functionName = "deployFactoryV3()";
  const fetchImpl = googleStub(({ source, target }) => {
    if (target !== "zh-CN") return source;
    return source
      .replaceAll(repositoryName, "连续清算拍卖")
      .replaceAll("Update", "更新")
      .replaceAll("Call", "调用")
      .replaceAll(" for contract ", "，合约 ");
  });

  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: fetchImpl,
    alertTranslationTimeoutMs: 500,
  }, {
    type: "github_module_update",
    launchpad: "Uniswap",
    repository,
    contract: address,
    message: `Call ${functionName}`,
  }, `Update: Call ${functionName} in ${repositoryName} for contract ${address}`);

  for (const block of [bundle.zh.text, bundle.en.text]) {
    for (const literal of [address, repositoryName, functionName]) {
      assert.ok(block.includes(literal), `rendered block lost or rewrote ${literal}`);
      assert.ok(block.split(literal).length - 1 <= 2, `rendered block duplicated ${literal} outside the fixed change/evidence fields`);
    }
  }
});

test("canonical date and technical-only fields render locally without a provider call or false fallback", async () => {
  clearTranslationCache();
  let calls = 0;
  const result = await translateAlertLines([
    "时间: 2026-08-12 12:00:00",
    "创建: 2025-07-09 03:32:21",
    "合约: 0x3333333333333333333333333333333333333333",
  ], {
    targetLanguage: "en",
    timeoutMs: 50,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("provider should not be called");
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.status, "translated_local");
  assert.equal(result.provider, "local_glossary");
  assert.deepEqual(result.lines, [
    "Time: 2026-08-12 12:00:00",
    "Created: 2025-07-09 03:32:21",
    "Contract: 0x3333333333333333333333333333333333333333",
  ]);
  assert.doesNotMatch(result.lines.join("\n"), /Translation unavailable/i);
});

test("English alert output normalizes Chinese punctuation left by mixed-language providers", async () => {
  clearTranslationCache();
  const result = await translateAlertLines(["状态: 官方页面已记录；链上部署/实际启用尚未确认"], {
    targetLanguage: "en",
    timeoutMs: 100,
    fetchImpl: googleStub(() => "Official page recorded；on-chain deployment or activation is not yet verified"),
  });

  assert.equal(result.lines[0], "Status: Official page recorded; on-chain deployment or activation is not yet verified");
  assert.doesNotMatch(result.lines[0], /[；，：]/);
});

test("a provider that ignores AbortSignal cannot hold a line request past the hard timeout", async () => {
  clearTranslationCache();
  const started = Date.now();
  const first = await translateAlertLines(["This provider never settles"], {
    targetLanguage: "zh-CN",
    timeoutMs: 30,
    fetchImpl: async () => new Promise(() => {}),
  });
  const firstElapsed = Date.now() - started;
  assert.equal(first.status, "fallback_source");
  assert.ok(firstElapsed < 250, `hard timeout took ${firstElapsed}ms`);

  let retryCalls = 0;
  const second = await translateAlertLines(["This provider never settles"], {
    targetLanguage: "zh-CN",
    timeoutMs: 100,
    fetchImpl: googleStub(({ source }) => {
      retryCalls += 1;
      return source.replace("This provider never settles", "第二次请求成功");
    }),
  });
  assert.equal(retryCalls, 1);
  assert.match(second.lines[0], /第二次请求成功/);
});

test("two alerts translating the same line keep independent timeout and abort budgets", async () => {
  clearTranslationCache();
  const source = "The same official update is observed twice";
  const shortBudget = translateAlertLines([source], {
    targetLanguage: "zh-CN",
    timeoutMs: 30,
    fetchImpl: async () => new Promise(() => {}),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const longBudget = translateAlertLines([source], {
    targetLanguage: "zh-CN",
    timeoutMs: 150,
    fetchImpl: googleStub(({ source: requestSource }) => requestSource.replace(source, "同一条官方更新被再次观察到")),
  });

  const [shortResult, longResult] = await Promise.all([shortBudget, longBudget]);
  assert.equal(shortResult.status, "fallback_source");
  assert.match(longResult.lines[0], /同一条官方更新被再次观察到/);
  assert.notEqual(longResult.status, "fallback_source");
});

test("local glossary rendering preserves a project name that is also an English domain word", async () => {
  clearTranslationCache();
  let calls = 0;
  const result = await translateAlertLines(["发射台: Pot 新底池"], {
    targetLanguage: "en",
    protectedTerms: ["Pot"],
    timeoutMs: 100,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("local glossary should be sufficient");
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.lines[0], "Launchpad: Pot New pool");
  assert.equal(result.lines[0].split("Pot").length - 1, 1);
});
