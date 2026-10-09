import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {entryStatus,renderEntryStatus} from '../dashboard/entry-status.js';
const now=Date.parse('2026-10-06T17:30:00Z');
const snapshot=()=>({status:'ok',updatedAt:new Date(now).toISOString(),enabled:false,
  lossGuards:{enforced:true,triggered:true,newEntriesStop:true,realizedPnlUsd:-10.037261,lossLimitUsd:10,dailyRealizedPnlUsd:-1.65,reasons:['本轮亏损达到额度']},
  account:{trades:[{side:'sell',symbol:'ZKBNB',atMs:now-1000},{side:'buy',symbol:'旧成交',atMs:now-2000}]}});
test('loss pause exposes budget, last real fill and independence from monitoring',()=>{
  const s=snapshot(),before=JSON.stringify(s),v=entryStatus(s,now);
  assert.equal(v.lossBlocked,true);assert.equal(v.visible,true);assert.match(v.label,/亏损预算触发/);
  assert.match(v.detail,/不会解除.*不自动恢复或补款/);
  assert.match(v.detail,/独立心跳/);assert.match(v.lastFill,/ZKBNB/);assert.match(v.lastFill,/北京时间/);
  const html=renderEntryStatus(v);assert.match(html,/-10.04 U/);assert.match(html,/10.00 U/);
  assert.equal(JSON.stringify(s),before);
});
test('unknown, stale, disconnected and future snapshots are never current permission',()=>{
  assert.match(entryStatus(null,now).label,/待同步/);
  for(const [offset,connected] of [[-15001,true],[1,true],[0,false]]){
    const s=snapshot();s.updatedAt=new Date(now+offset).toISOString();
    const v=entryStatus(s,now,connected);assert.equal(v.online,false);assert.match(v.detail,/上次记录/);
  }
  const s=snapshot();s.publicView=true;s.updatedAt=new Date(now-59000).toISOString();assert.equal(entryStatus(s,now).online,true);
});
test('manual pause, global block and enabled states do not invent a loss trigger',()=>{
  const s=snapshot();delete s.lossGuards;
  assert.match(entryStatus(s,now).label,/新增仓位已暂停/);assert.equal(entryStatus(s,now).lossBlocked,false);
  s.enabled=true;s.entryGuard={allowed:false,reasons:['余额不足']};assert.match(entryStatus(s,now).detail,/余额不足/);
  s.entryGuard.allowed=true;assert.equal(renderEntryStatus(entryStatus(s,now)),'');
  s.lossGuards={enforced:false,triggered:true};assert.equal(entryStatus(s,now).blocked,false);
});
test('untrusted reasons and symbols are escaped; unknown amounts and future trades are not invented',()=>{
  const s=snapshot();s.lossGuards.reasons=['<img src=x>'];s.lossGuards.realizedPnlUsd=null;
  s.account.trades[0].symbol='<script>bad</script>';s.account.trades.push({side:'buy',symbol:'未来',atMs:now+1});
  const html=renderEntryStatus(entryStatus(s,now));assert.match(html,/&lt;img/);assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>|<img|未来/);assert.match(html,/未记录/);
});
test('status view is read-only and lives inside the brain anchor',async()=>{
  const code=await fs.readFile(new URL('../dashboard/entry-status.js',import.meta.url),'utf8');
  assert.doesNotMatch(code,/\bfetch\s*\(|setInterval\s*\(|localStorage|strategy-control/);
  const brain=await fs.readFile(new URL('../dashboard/brain-desk.js',import.meta.url),'utf8');
  assert.match(brain,/data-brain-entry-status/);assert.match(brain,/renderEntryStatus\(view.entry\)/);
});
