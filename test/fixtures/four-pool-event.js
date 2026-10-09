// Real closed envelopes emitted by the producer, not handwritten proof flags.
import { isFourRegistryTrackedTokenEvent } from '../../src/four-registry-monitor.js';
import { FourRegistryFakeProvider, fourRegistryPreset, fourRegistryTxHash,
  createFourRegistryFixture, addFourRegistryPresetUpsert, addFourRegistryTokenCreated,
} from '../helpers/four-registry-fixture.js';

export async function fourPoolEvents(t, { nowMs = Date.parse('2026-09-04T08:00:00.000Z'),
  presetId = '777', version = '2.0.0', count = 3 } = {}) {
  const provider = new FourRegistryFakeProvider({ head: 102 });
  provider.setSnapshot(100, []);
  for (const block of [100, 101, 102]) provider.setBlockTimestamp(block, Math.floor(nowMs / 1000) - (104 - block));
  const fixture = await createFourRegistryFixture(t, provider, { now: () => nowMs });
  await fixture.monitor.check();
  const preset = fourRegistryPreset(presetId, { version });
  provider.setSnapshot(101, [preset]);
  addFourRegistryPresetUpsert(provider, preset);
  for (let ordinal = 1; ordinal <= count; ordinal++) {
    const digit = String(ordinal + 1);
    addFourRegistryTokenCreated(provider, preset, { blockNumber: 102, transactionIndex: ordinal + 1,
      hash: fourRegistryTxHash(digit), token: `0x${digit.repeat(40)}`, name: `Four ${ordinal}`, symbol: `F${ordinal}` });
  }
  provider.head = 104;
  const result = await fixture.monitor.check();
  if (result.status !== 'ok') throw new Error(`Four fixture producer failed: ${JSON.stringify(result)}`);
  return { ...fixture, provider, preset, events: result.events,
    capability: result.events.find(e => e.type === 'platform_capability_update'),
    tokenEvents: result.events.filter(isFourRegistryTrackedTokenEvent) };
}

export const createFourPoolEvents = fourPoolEvents;
