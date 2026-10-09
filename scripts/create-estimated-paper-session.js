import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {createEstimatedPaperSession} from '../src/paper-account-session.js';
const dataDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data');
const id=process.argv[2];if(!id)throw Error('Provide an explicit estimated session id; runtime must be stopped');
const s=await createEstimatedPaperSession({dataDir,id});
console.log(JSON.stringify({id:s.id,label:s.label,initialCash:s.initialCash,oldMainCash:s.legacy.cash,oldMainTrades:s.legacy.tradeCount,
  costModel:s.costModel,enabled:false,execution:false,signing:false,broadcast:false}));
