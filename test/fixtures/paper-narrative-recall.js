import { createCapitalKolEventSnapshot } from '../../src/capital-kol-catalog.js';
export const NOW=Date.parse('2026-09-23T06:00:00Z'),DAY=86400000,CA=`0x${'a'.repeat(40)}`;
export const TEXT='robotaxi orbital starlight autonomous taxi fleet';
export function kolEvent(text=TEXT,when=NOW-1000,id='2102563652285145999') {
  return {type:'kol_narrative_observation',tweet:{id,text,url:`https://x.com/elonmusk/status/${id}`,
    handle:'elonmusk',xUserId:'44196397',authorId:'44196397',createdAt:new Date(when).toISOString(),
    sourceVerifiedBy:'official_x_oembed',isReply:false,isQuote:false},
    caller:{handle:'elonmusk',xUserId:'44196397',capitalKolSnapshot:createCapitalKolEventSnapshot('elonmusk'),
      capitalKolBinding:{handle:'elonmusk',xUserId:'44196397',source:'fxtwitter_public_profile',observedAt:new Date(when).toISOString()}},
    observedAt:new Date(when+100).toISOString(),simulationOnly:true};
}
export function candidate(when=NOW,extra={}) {
  return {marketStatus:'ok',observedAt:new Date(when).toISOString(),token:{chain:'base',address:CA,symbol:'OFFLINE_OG',
    price:1,marketCap:1000000,historyHighestMarketCap:5000000,liquidity:60000,volume:5000,...extra}};
}
export function historyEvent() { return {...kolEvent(`${TEXT} ${CA}`,NOW-DAY,'2102563652285145000'),chain:'base'}; }
