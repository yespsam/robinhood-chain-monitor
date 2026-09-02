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

test("line translation rejects changed monetary magnitudes and falls back without copying the wrong prose", async () => {
  clearTranslationCache();
  const source = "事件：Bullish 向 USD.AI 提供1亿美元信贷，并锁定2.25亿美元储备";
  const wrong = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async (url) => googleResponse((new URL(url).searchParams.get("q") || "")
      .replace("事件：", "Event: ")
      .replace(" 向 ", " provided ")
      .replace(" 提供1亿美元信贷，并锁定2.25亿美元储备", " with $1 million in credit and locked $2.25 billion in reserves")),
  });

  assert.equal(wrong.status, "fallback_source");
  assert.match(wrong.lines[0], /English translation unavailable; see verified Chinese facts/);
  assert.doesNotMatch(wrong.lines[0], /\$1 million|\$2\.25 billion/);
  assert.match(wrong.error, /monetary amount/);

  clearTranslationCache();
  const correct = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async (url) => googleResponse((new URL(url).searchParams.get("q") || "")
      .replace("事件：", "Event: ")
      .replace(" 向 ", " provided ")
      .replace(" 提供1亿美元信贷，并锁定2.25亿美元储备", " with $100 million in credit and locked $225 million in reserves")),
  });
  assert.equal(correct.status, "translated");
  assert.match(correct.lines[0], /\$100 million/);
  assert.match(correct.lines[0], /\$225 million/);
});

test("monetary direction signs survive translation and cannot flip an outflow into a gain", async () => {
  const source = "事件：基金净流出-1亿美元，资金费率+0.25%";
  clearTranslationCache();
  const wrong = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("Event: Fund gained $100 million; funding rate 0.25%"),
  });
  assert.equal(wrong.status, "fallback_source");
  assert.match(wrong.error, /monetary amount|percentage/);

  clearTranslationCache();
  const correct = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("Event: Fund net outflow -$100 million; funding rate +0.25%"),
  });
  assert.equal(correct.status, "translated");
  assert.match(correct.lines[0], /-\$100 million/);
  assert.match(correct.lines[0], /\+0\.25%/);
});

test("financial flow words cannot flip an unsigned net outflow into an inflow", async () => {
  const source = "事件：基金净流出1亿美元";
  clearTranslationCache();
  const wrong = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("Event: fund net inflow $100 million"),
  });
  assert.equal(wrong.status, "fallback_source");
  assert.match(wrong.error, /financial flow direction/);

  clearTranslationCache();
  const correct = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("Event: fund net outflow $100 million"),
  });
  assert.equal(correct.status, "translated");
  assert.match(correct.lines[0], /net outflow \$100 million/);

  clearTranslationCache();
  const firstOutflow = await translateAlertLines(["Event: first outflow in 9 days"], {
    targetLanguage: "zh-CN",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("事件：9天来首次净流出"),
  });
  assert.equal(firstOutflow.status, "translated");

  clearTranslationCache();
  const flippedFirstOutflow = await translateAlertLines(["Event: first outflow in 9 days"], {
    targetLanguage: "zh-CN",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("事件：9天来首次净流入"),
  });
  assert.equal(flippedFirstOutflow.status, "fallback_source");
  assert.match(flippedFirstOutflow.error, /financial flow direction/);
});

test("numeric market directions cannot flip while contextless up remains ordinary prose", async () => {
  for (const [source, mistranslation] of [
    ["事件：比特币价格上涨10%", "Event: Bitcoin price fell 10%"],
    ["事件：代币供应量减少20%", "Event: token supply increased 20%"],
    ["事件：资金费率下降0.25%", "Event: funding rate rose 0.25%"],
  ]) {
    clearTranslationCache();
    const result = await translateAlertLines([source], {
      targetLanguage: "en",
      timeoutMs: 200,
      fetchImpl: async () => googleResponse(mistranslation),
    });
    assert.equal(result.status, "fallback_source");
    assert.match(result.error, /numeric direction/);
    assert.doesNotMatch(result.lines[0], new RegExp(mistranslation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  clearTranslationCache();
  const correct = await translateAlertLines(["事件：比特币价格上涨10%"], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("Event: Bitcoin price rose 10%"),
  });
  assert.equal(correct.status, "translated");

  for (const [directionSource, translation] of [
    ["事件：比特币价格上涨10%", "Event: Bitcoin price rose 10%"],
    ["事件：比特币价格增加10%", "Event: Bitcoin price increased 10%"],
    ["事件：利率上调10%", "Event: interest rate gained 10%"],
    ["事件：比特币价格上涨10%", "Event: Bitcoin price was up 10%"],
    ["事件：比特币价格下跌10%", "Event: Bitcoin price fell 10%"],
    ["事件：供应量减少10%", "Event: supply decreased 10%"],
    ["事件：利率下调10%", "Event: interest rate dropped 10%"],
    ["事件：比特币价格下跌10%", "Event: Bitcoin price was down 10%"],
  ]) {
    clearTranslationCache();
    const synonym = await translateAlertLines([directionSource], {
      targetLanguage: "en",
      timeoutMs: 200,
      fetchImpl: async () => googleResponse(translation),
    });
    assert.equal(synonym.status, "translated");
  }

  clearTranslationCache();
  const setup = await translateAlertLines(["Event: Set up routing for 10 validator nodes"], {
    targetLanguage: "zh-CN",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("事件：为10个验证节点设置路由"),
  });
  assert.equal(setup.status, "translated");
});

test("opposite moves stay bound to their own metric and numeric value", async () => {
  const source = "事件：比特币价格上涨10%；代币供应量减少20%";
  clearTranslationCache();
  const swapped = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("Event: Bitcoin price fell 10%; token supply increased 20%"),
  });
  assert.equal(swapped.status, "fallback_source");
  assert.match(swapped.error, /numeric direction/);

  clearTranslationCache();
  const correct = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("Event: Bitcoin price rose 10%; token supply decreased 20%"),
  });
  assert.equal(correct.status, "translated");
});

test("asset price threshold verbs preserve direction without treating ordinary above or below as a market move", async () => {
  const source = "事件：BTC跌破7.7万美元";
  for (const [translation, expectedStatus] of [
    ["Event: BTC rose above $77,000", "fallback_source"],
    ["Event: BTC fell below $77,000", "translated"],
  ]) {
    clearTranslationCache();
    const result = await translateAlertLines([source], {
      targetLanguage: "en",
      timeoutMs: 200,
      fetchImpl: async (url) => googleResponse((new URL(url).searchParams.get("q") || "")
        .replace("事件：", "Event: ")
        .replace("跌破7.7万美元", translation.replace("Event: BTC", ""))),
    });
    assert.equal(result.status, expectedStatus);
    if (expectedStatus === "fallback_source") assert.match(result.error, /numeric direction/);
  }

  clearTranslationCache();
  const ordinaryComparison = await translateAlertLines(["事件：阈值高于10，文件位于第20行下方"], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("Event: threshold is above 10, and the file is below line 20"),
  });
  assert.equal(ordinaryComparison.status, "translated");
});

test("each asset keeps its nearest price direction when English joins two facts with and", async () => {
  const source = "事件：BTC跌至77,520、ETH跌至2,412";
  const provider = (secondMove) => async (url) => googleResponse((new URL(url).searchParams.get("q") || "")
    .replace("事件：", "Event: ")
    .replace("跌至77,520、", " fell to $77,520 and ")
    .replace("跌至2,412", ` ${secondMove} $2,412`));

  clearTranslationCache();
  const correct = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: provider("fell to"),
  });
  assert.equal(correct.status, "translated");
  assert.match(correct.lines[0], /BTC fell to \$77,520 and ETH fell to \$2,412/);

  clearTranslationCache();
  const flipped = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: provider("rose above"),
  });
  assert.equal(flipped.status, "fallback_source");
  assert.match(flipped.error, /numeric direction/);
});

test("dates, plain USD suffixes, CNY quantities, and token counts keep equivalent values", async () => {
  const source = "事件：截至9月1日，基金净流出1.2亿元人民币；比特币价格为77,520美元，以太坊价格为2,412美金；解锁3万枚代币";
  const correctEnglish = "Event: As of September 1, the fund recorded a net outflow of CNY 120 million; Bitcoin price was $77,520 and Ethereum price was $2,412; 30,000 tokens were unlocked";

  clearTranslationCache();
  const correct = await translateAlertLines([source], {
    targetLanguage: "en",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse(correctEnglish),
  });
  assert.equal(correct.status, "translated");
  assert.match(correct.lines[0], /September 1/);
  assert.match(correct.lines[0], /CNY 120 million/);
  assert.match(correct.lines[0], /\$77,520/);
  assert.match(correct.lines[0], /\$2,412/);
  assert.match(correct.lines[0], /30,000 tokens/);

  for (const [mistranslation, expectedError] of [
    [correctEnglish.replace("$77,520", "$77,521"), /monetary amount/],
    [correctEnglish.replace("net outflow", "net inflow"), /financial flow direction/],
    [correctEnglish.replace("CNY 120 million", "CNY 119 million"), /monetary amount/],
    [correctEnglish.replace("30,000 tokens", "29,999 tokens"), /token count/],
    [correctEnglish.replace("September 1", "September 2"), /date/],
  ]) {
    clearTranslationCache();
    const rejected = await translateAlertLines([source], {
      targetLanguage: "en",
      timeoutMs: 200,
      fetchImpl: async () => googleResponse(mistranslation),
    });
    assert.equal(rejected.status, "fallback_source");
    assert.match(rejected.error, expectedError);
  }

  clearTranslationCache();
  const reverse = await translateAlertLines([correctEnglish], {
    targetLanguage: "zh-CN",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse(source),
  });
  assert.equal(reverse.status, "translated");

  clearTranslationCache();
  const plainUsdSuffix = await translateAlertLines(["Event: Bitcoin price was 77,520 USD"], {
    targetLanguage: "zh-CN",
    timeoutMs: 200,
    fetchImpl: async () => googleResponse("事件：比特币价格为$77,520"),
  });
  assert.equal(plainUsdSuffix.status, "translated");
});

test("translation failure preserves only the matching source-language facts", async () => {
  const chineseSource = "事件：比特币价格上涨10%，并保留 verified market context";
  clearTranslationCache();
  const chinese = await translateAlertLines([chineseSource], {
    targetLanguage: "zh-CN",
    timeoutMs: 50,
    fetchImpl: async (url) => googleResponse(new URL(url).searchParams.get("q")),
  });
  assert.equal(chinese.status, "fallback_source");
  assert.match(chinese.lines[0], /比特币价格上涨10%/);

  clearTranslationCache();
  const unavailableEnglish = await translateAlertLines([chineseSource], {
    targetLanguage: "en",
    timeoutMs: 25,
    fetchImpl: async () => new Promise(() => {}),
  });
  assert.equal(unavailableEnglish.status, "fallback_source");
  assert.match(unavailableEnglish.lines[0], /English translation unavailable/);
  assert.doesNotMatch(unavailableEnglish.lines[0], /比特币价格上涨/);

  const englishSource = "Event: Bitcoin price rose 10%; the verified market move remains intact；官方市场数据已经确认";
  clearTranslationCache();
  const english = await translateAlertLines([englishSource], {
    targetLanguage: "en",
    timeoutMs: 50,
    fetchImpl: async (url) => googleResponse(new URL(url).searchParams.get("q")),
  });
  assert.equal(english.status, "fallback_source");
  assert.match(english.lines[0], /Bitcoin price rose 10%/);

  clearTranslationCache();
  const unavailableChinese = await translateAlertLines([englishSource], {
    targetLanguage: "zh-CN",
    timeoutMs: 25,
    fetchImpl: async () => new Promise(() => {}),
  });
  assert.equal(unavailableChinese.status, "fallback_source");
  assert.match(unavailableChinese.lines[0], /中文翻译暂不可用/);
  assert.doesNotMatch(unavailableChinese.lines[0], /Bitcoin price rose/);
});

test("an unchanged English provider response cannot masquerade as a Chinese translation", async () => {
  clearTranslationCache();
  const source = "Event: Binance launches a new perpetual contract for TESTUSDT";
  const result = await translateAlertLines([source], {
    targetLanguage: "zh-CN",
    timeoutMs: 200,
    protectedTerms: ["Binance", "TESTUSDT"],
    fetchImpl: async (url) => googleResponse(new URL(url).searchParams.get("q")),
  });

  assert.equal(result.status, "fallback_source");
  assert.match(result.lines[0], /中文翻译暂不可用；请看英文原文/);
  assert.doesNotMatch(result.lines[0], /Binance launches a new perpetual contract/);
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
    assert.match(block, /08-18 17:30 CST/);
    assert.equal((block.match(/08-18 17:30 CST/g) || []).length, 1, "source CST timestamp must be mirrored once per language");
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
