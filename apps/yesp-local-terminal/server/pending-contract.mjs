import {fault,same} from './flap-reader.mjs';
// History supplies candidates only. A match still needs the exact prepared
// wallet, nonce, contract, calldata and value, followed by receipt verification.
export async function pendingContractHash({cli,rpc,op}) {
 const s=op.steps[0],p=s.plan;
 if((!s.orderId&&op.action!=='transfer'&&s.status!=='PENDING_CONFIRMATION')||!p.tx||typeof cli.recentTransactions!=='function')return null;
 const hashes=await cli.recentTransactions({chainId:'56',since:Math.max(0,s.startedAt-60000)});
 for(const hash of hashes){const tx=await rpc('eth_getTransactionByHash',[hash]);
  if(!tx||!same(tx.from,p.wallet)||BigInt(tx.nonce)!==BigInt(p.nonce))continue;
  if(!same(tx.hash,hash)||!same(tx.to,p.tx.to)||!same(tx.input,p.tx.inputData)||BigInt(tx.value)!==BigInt(p.tx.value))throw fault('PENDING_TRANSACTION_CHANGED');
  return hash;
 }return null;
}
