import {createPaperEvidenceIndex} from './paper-strategy-evidence.js';
import {gmgnFlowAddress} from './gmgn-flow-signal.js';
import {validBinanceFlowState, BINANCE_FLOW_KINDS} from './binance-flow-evidence.js';
import {buildPoolFirstThreeWire} from './paper-pool-signal.js';
import {walletBuyResearchHint} from './paper-wallet-priority.js';
import {buildCollectiveWire} from './paper-collective-signal.js';

// Local, public evidence only. A trigger requests the existing evaluator; it
// does not manufacture a catalyst, wallet profile, quote or permission to buy.
export function paperEventTriggers({evidence={},account,chains,nowMs,allowPrequalified=false,allowBurst=false}) {
  const pool=buildPoolFirstThreeWire({events:evidence.events||[],account,nowMs});
  const binanceState=validBinanceFlowState(evidence.binanceState)?evidence.binanceState:null;
  const index=createPaperEvidenceIndex({...evidence,binanceState});
  const wallets=chains.flatMap(chain=>{
    const addresses=new Set();
    for(const rows of [evidence.flowState?.trades?.[chain]||[],
      ...BINANCE_FLOW_KINDS.map(kind=>binanceState?.chains?.[chain]?.feeds?.[kind]?.rows||[])]) {
      for(const row of rows) {
        const address=gmgnFlowAddress(chain,row?.tokenAddress);
        if(address&&row.chain===chain&&row.side==='buy'&&Number.isFinite(row.at)
          &&row.at>=nowMs-90000&&row.at<=nowMs)addresses.add(address);
      }
    }
    return [...addresses].flatMap(address=>{
      const token={chain,address};
      // A stale-but-complete GMGN cohort must not mask a newer secondary buy.
      // This is a wake-up, NOT a change to the evaluator's cohort or criteria.
      const hints=index.flowSources({chain,address,nowMs})
        .map(flow=>walletBuyResearchHint({token,flow,memeExitMode:true},nowMs)).filter(Boolean)
        .sort((a,b)=>Date.parse(b.buyAt)-Date.parse(a.buyAt));
      const hint=hints[0];
      if(!hint)return [];
      const kind=hint.provider.replace(/^binance_/,''),coverage=binanceState?.chains?.[chain]?.feeds?.[kind]?.coverage;
      const receivedAt=coverage?.receivedAt;
      return [{...token,id:`${chain}:${address}:wallet_buy:${Date.parse(hint.buyAt)}`,source:'wallet_buy',provider:hint.provider,
        sourceAt:hint.buyAt,sourceObservedAt:hint.observedAt,sourceWindowEndAt:hint.observedAt,
        // This is the current snapshot receipt, not the first receipt of this
        // trade. GMGN merges two feeds and cannot provide that attribution.
        sourceSnapshotReceivedAt:Number.isFinite(receivedAt)&&receivedAt<=nowMs?new Date(receivedAt).toISOString():null}];
    });
  }).sort((a,b)=>Date.parse(b.sourceAt)-Date.parse(a.sourceAt)||a.chain.localeCompare(b.chain)||a.address.localeCompare(b.address));
  const collective=chains.includes('bsc')?buildCollectiveWire({state:evidence.flowState,onchainState:evidence.innerTradeState,account,nowMs,allowPrequalified,allowBurst}).signals:[];
  return [...collective.map(s=>({chain:s.chain,address:s.address,id:s.id,source:s.source,provider:s.provider,
    sourceAt:s.sourceAt,sourceObservedAt:s.sourceObservedAt,sourceWindowEndAt:s.sourceObservedAt})),
    ...pool.signals.filter(s=>chains.includes(s.chain)).map(s=>({chain:s.chain,address:s.address,id:s.id,
    source:'new_pool_first_three',sourceAt:s.sourceAt,sourceObservedAt:s.poolEvent.observedAt})),
    ...wallets.filter(w=>!collective.some(s=>s.chain===w.chain&&s.address===w.address))];
}
