// Only receipt-backed Portal configuration changes may open a new generation.
// A documentation/package version, quote label, or repeated event is not one.
import { Interface } from "ethers";

const portal = "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0";
const configurationEvent = new Interface([
  "event QuoteTokenConfigurationSet(address quoteToken,(uint8 enabled,uint8 defaultCurve,uint8 alternativeCurve,uint8 nativeToQuoteSwapType,uint8 dexId) config)",
]);
export const FLAP_QUOTE_CONFIGURATION_FIELDS = [
  "enabled", "enabledRaw", "defaultCurve", "alternativeCurve", "nativeToQuoteSwapType", "dexId",
];

export function validFlapQuoteConfiguration(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === FLAP_QUOTE_CONFIGURATION_FIELDS.length
    && FLAP_QUOTE_CONFIGURATION_FIELDS.every((key) => Object.hasOwn(value, key))
    && typeof value.enabled === "boolean"
    && value.enabledRaw === (value.enabled ? 1 : 0)
    && FLAP_QUOTE_CONFIGURATION_FIELDS.slice(2).every((key) =>
      Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 255);
}

export function isMaterialFlapQuoteConfigurationChange(before, after) {
  return validFlapQuoteConfiguration(before) && validFlapQuoteConfiguration(after)
    && before.enabled === true && after.enabled === true
    && FLAP_QUOTE_CONFIGURATION_FIELDS.slice(2).some((key) => before[key] !== after[key]);
}

export function sameFlapQuoteConfiguration(left, right) {
  return validFlapQuoteConfiguration(left) && validFlapQuoteConfiguration(right)
    && FLAP_QUOTE_CONFIGURATION_FIELDS.every((key) => left[key] === right[key]);
}

export function encodeFlapQuoteConfigurationLog(quoteAddress, configuration) {
  if (!/^0x[a-f0-9]{40}$/.test(quoteAddress) || !validFlapQuoteConfiguration(configuration)) {
    throw new Error("invalid Flap configuration log input");
  }
  const log = configurationEvent.encodeEventLog(configurationEvent.getEvent("QuoteTokenConfigurationSet"),
    [quoteAddress, [configuration.enabledRaw, configuration.defaultCurve, configuration.alternativeCurve,
      configuration.nativeToQuoteSwapType, configuration.dexId]]);
  return { address: portal, topics: log.topics, data: log.data };
}

export function validFlapQuoteConfigurationLog(log, quoteAddress, configuration) {
  if (!log || typeof log !== "object" || Array.isArray(log)
    || Object.keys(log).length !== 3 || !["address", "topics", "data"].every((key) => Object.hasOwn(log, key))) return false;
  let expected;
  try { expected = encodeFlapQuoteConfigurationLog(quoteAddress, configuration); } catch { return false; }
  return log.address === expected.address && Array.isArray(log.topics) && log.topics.length === 1
    && log.topics[0] === expected.topics[0] && log.data === expected.data;
}
