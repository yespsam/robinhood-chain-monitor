import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fourPoolEvents} from './fixtures/four-pool-event.js';
import {buildBilingualAlertBundle,renderBilingualTelegramText} from '../src/bilingual-alert-renderer.js';

test('Four second and third CA cards mirror ordinal and immutable identifiers in both languages',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'launch-card-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {tokenEvents}=await fourPoolEvents(t,{nowMs:Date.parse('2026-10-09T12:00:00Z')});
  for(const event of tokenEvents.slice(1)){
    const before=JSON.stringify(event),bundle=await buildBilingualAlertBundle({},event,'Four.Meme Core TokenCreated');
    const rendered=renderBilingualTelegramText(bundle,true);
    assert.equal(JSON.stringify(event),before);
    const blocks=rendered.split('🇬🇧 English');assert.equal(blocks.length,2);
    for(const block of blocks){assert.ok(block.includes(`CA ${event.featureTokenOrdinal}/3`));
      assert.ok(block.includes(event.tokens[0].token));assert.ok(block.includes(event.explorerUrl));}
    assert.doesNotMatch(rendered,/首个 CA|first CA/);
    const file=path.join(dir,`${event.featureTokenOrdinal}.txt`),source=path.join(dir,'source.txt');
    await fs.writeFile(file,rendered);await fs.writeFile(source,`${event.tokens[0].token}\n${event.explorerUrl}`);
    // The optional installed skill validator is local-only; CI retains the
    // equivalent identifier assertions without depending on a user's home.
    const validator=path.join(os.homedir(),'.codex/skills/render-bilingual-alerts/scripts/validate-bilingual-alert.mjs');
    if(await fs.access(validator).then(()=>true,()=>false))
      await promisify(execFile)(process.execPath,[validator,file,'--source',source]);
  }
});
