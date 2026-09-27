import { isStrictGeniusEvent } from './genius-source-policy.js';
import { hasGeniusBusinessChanges, isGeniusTechnicalChange } from './genius-summary.js';

export const GENIUS_NOTIFICATION_POLICY_VERSION = 'genius_platform_updates_v2';
const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const navigation = /^(?:[·•|/\-–—]+|(?:[·•|]\s*)?(?:Foundation|Home|About|Docs|Documentation|Integrate|English|EN|中文|简体中文|繁體中文|Connect Wallet|Genius\.fun))$/iu;
const urls = /https?:\/\/[^\s<>]+|(?:pic\.(?:twitter|x)\.com)\/[^\s<>]+/giu;
const mediaUrls = /(?:https?:\/\/)?(?:pic\.(?:twitter|x)\.com|pbs\.twimg\.com|video\.twimg\.com)\/[^\s<>]+/giu;
const decoration = /^[\s\p{P}\p{S}\uFE0F]*$/u;

// Delivery is opt-in for concrete platform changes. Ordinary official posts
// remain in the audit outbox; identity or a pasted CA is not update evidence.
export function geniusNotificationPolicy(event) {
  const result = (notify, reason) => ({ version: GENIUS_NOTIFICATION_POLICY_VERSION, notify, reason });
  if (!isStrictGeniusEvent(event)) return result(false, 'genius_invalid_source');
  if (event.sourceId === 'genius_chain') return result(true, 'genius_verified_chain_change');
  if (['manifest_update', 'docs_update'].includes(event.kind)) {
    if (!hasGeniusBusinessChanges(event.changes)) return result(false, 'genius_technical_only');
    const noise = event.changes.every(change => isGeniusTechnicalChange(change)
      || change.field === 'document' && [change.before, change.after].filter(v => v != null)
        .every(v => typeof v === 'string' && navigation.test(clean(v))));
    if (noise) return result(false, 'genius_navigation_only');
    return result(true, 'genius_substantive_document_change');
  }
  const original = clean(event.tweet?.text);
  // Do not infer what is in an image. Keep it in the audit outbox, with its link.
  if (original.match(mediaUrls)?.length && decoration.test(original.replace(mediaUrls, ''))) {
    return result(false, 'genius_media_without_text');
  }
  // Removing links is only used for these complete, exact promotional phrases.
  // A new feature, rate, date, CA or explanatory clause cannot match this list.
  const prose = clean(original.replace(urls, '')).replace(/[.!。！\s👇👀🧠]+$/gu, '').trim();
  if (/^(?:Launch your (?:token|takeover)(?: and start earning creator fees)?(?: at| here)?|Join (?:them|us) and launch your own|Start your hostile takeover|Join the wave|立即发币|马上发币)$/iu.test(prose)) {
    return result(false, 'genius_promotion_only');
  }
  if (/^(?:Approaching\s+)?[\d,]+\s+shares$/iu.test(prose)) return result(false, 'genius_counter_only');
  // Test deployments and official corrections are operational updates, but
  // "testing something" or a caller-provided flag alone must not qualify.
  if (/\b(?:not (?:affiliated|associated)|did not (?:issue|launch)|didn['’]?t (?:issue|launch))\b|非官方|不是官方|否认.{0,12}(?:发行|关联)/iu.test(prose))
    return result(true, 'genius_official_correction');
  if (/\b(?:test token|testnet|testing (?:token|deployment|contract))\b|(?:官方|新|上线|部署|发行|更新).{0,12}测试(?:币|代币|网|合约)/iu.test(prose))
    return result(true, 'genius_test_update');
  const feature = '(?:routing|swaps?|pairing|fees?|launchpad|factory|contracts?|api|sdk|wallets?|bridge|bridging|features?|versions?|releases?|deployments?|migration|mainnet|trading|buybacks?)';
  const update = '(?:live|added|announced|released?|updated?|upgraded?|changed?|reduced?|increased?|enabled?|disabled?|paused?|resumed?|launched?|deployed?|fixed|removed|deprecated|migrat\\w*|outage|maintenance)';
  // Require a nearby change predicate, not merely "new" plus a market noun.
  const changedFeature = new RegExp(`\\b${feature}\\b[^.!?。！？]{0,50}\\b${update}\\b|\\b${update}\\b[^.!?。！？]{0,50}\\b${feature}\\b`, 'iu');
  if (changedFeature.test(prose)
    || /\blaunches?\s+(?:(?:are|is|have been|has been)\s+)?(?:paused|resumed|enabled|disabled)\b/iu.test(prose)
    || /(?:新增|更新|升级|调整|降低|提高|暂停|恢复|开放|关闭|修复|停用|维护).{0,24}(?:功能|版本|合约|手续费|费用|费率|路由|跨链|发射台|钱包|迁移|主网)|(?:功能|版本|合约|手续费|费用|费率|路由|跨链|发射台|钱包|迁移|主网).{0,24}(?:上线|发布|更新|升级|调整|暂停|恢复|开放|关闭|修复|维护|故障)/u.test(prose))
    return result(true, 'genius_platform_update');
  if (/\b(?:introducing|launching|released)\s+genius\s+[a-z][\w.-]+/iu.test(prose))
    return result(true, 'genius_platform_update');
  // Concrete new capabilities can be expressed without the word "feature".
  if (/\byou can now (?:pair|swap|bridge|trade|deploy|launch|connect)\b|现在(?:可以|支持).{0,24}(?:交易|兑换|跨链|配对|部署|发币)/iu.test(prose))
    return result(true, 'genius_platform_update');
  return result(false, 'genius_not_platform_update');
}
