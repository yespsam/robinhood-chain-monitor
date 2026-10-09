import { gmgnFlowAddress } from './gmgn-flow-signal.js';

export const GMGN_THREE_LISTS = 'gmgn_three_lists_v1';
export const FOCUSED_TRENCHES = Object.freeze(['new_creation','near_completion','completed']);
export const FOCUSED_REFRESH_MS = 15000;
const labels={new_creation:'战壕·新创建',near_completion:'战壕·即将开盘',completed:'战壕·已开盘',ranking_5m:'热门·5分钟'};

// Membership comes only from a fresh successful list response, never from a
// cached detail, a wallet event, a remembered name or a refreshed quote.
export function focusedListTokens(snapshot,index,nowMs) {
  const at=Date.parse(snapshot?.observedAt||'');
  if(snapshot?.status!=='ok'||!Number.isFinite(at)||at>nowMs||nowMs-at>120000)return [];
  if(index===0)return snapshot.interval==='5m'?(snapshot.tokens||[]).filter(t=>t.volumeWindow==='5m'):[];
  if(index!==1)return [];
  const tokens=snapshot.categories?FOCUSED_TRENCHES.flatMap(type=>snapshot.categories[type]||[]):snapshot.tokens||[];
  return tokens.filter(t=>FOCUSED_TRENCHES.includes(t.marketCategory));
}

export function focusedMembership(snapshots,chain,nowMs) {
  const members=new Map();
  snapshots.forEach((snapshot,index)=>{
    for(const token of focusedListTokens(snapshot,index,nowMs)) {
      const address=gmgnFlowAddress(chain,token?.address);
      if(token?.chain!==chain||!address)continue;
      const key=`${chain}:${address}`,list=index===0?'ranking_5m':token.marketCategory;
      const value=members.get(key)||[];
      if(!value.some(x=>x.list===list))value.push({list,label:labels[list],observedAt:snapshot.observedAt});
      members.set(key,value);
    }
  });
  return members;
}

export function focusedDiscoverySnapshot(snapshots,scanChains,nowMs) {
  const feeds=scanChains.flatMap(chain=>[...FOCUSED_TRENCHES,'ranking_5m'].map(list=>{
    const index=list==='ranking_5m'?0:1,snapshot=snapshots.get(chain)?.[index];
    const count=new Set(focusedListTokens(snapshot,index,nowMs)
      .filter(t=>t.chain===chain&&(index===0||t.marketCategory===list))
      .map(t=>gmgnFlowAddress(chain,t.address)).filter(Boolean)).size;
    const at=Date.parse(snapshot?.observedAt||'');
    const status=snapshot?.status==='ok'&&(!Number.isFinite(at)||at>nowMs||nowMs-at>120000)?'stale':snapshot?.status||'loading';
    return {chain,list,label:labels[list],status,observedAt:snapshot?.observedAt||null,count,reasonCode:snapshot?.reasonCode||null};
  }));
  return {version:GMGN_THREE_LISTS,feeds,refreshTargetMs:FOCUSED_REFRESH_MS,
    uniqueCandidates:scanChains.reduce((n,c)=>n+focusedMembership(snapshots.get(c)||[],c,nowMs).size,0),
    otherSources:'verified_internal_wallet_only',holdings:'exit_management_unchanged',
    note:'战壕新创建、即将开盘、已开盘及5分钟热门；内盘核验地址/逐笔放量可独立补证，榜外外盘不放行。5分钟是统计窗口。普通喊单及研究名册不授予资格；TG/FOMO 保持。'};
}
