import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Interface, getAddress, parseUnits, formatUnits, keccak256 } from 'ethers';
import { createFastTradeCli } from './fast-trade-cli.mjs';
import { createFlapRpc, fault, same } from './flap-reader.mjs';
import { FlapJournal, TERMINAL } from './flap-journal.mjs';
import {pendingContractHash} from './pending-contract.mjs';

export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const transferAbi = new Interface(['function decimals() view returns(uint8)', 'function symbol() view returns(string)',
  'function balanceOf(address) view returns(uint256)', 'function transfer(address,uint256) returns(bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const ZERO = '0x0000000000000000000000000000000000000000';
const cleanError = e => ({ code: /^[A-Z][A-Z0-9_]{0,80}$/.test(e?.code || '') ? e.code : 'READ_FAILED' });
const noSubmission = e => Object.assign(e, { submissionNotStarted: true });
export function validateTransferFields(method, p) {
  const names = { walletStatus: [], transferPrepare: ['recipient','tokenAddress','amount'],
    transfer: ['previewId','intentId'], transferReconcile: ['intentId','txHash'] }[method];
  if (!names || !p || typeof p !== 'object' || Array.isArray(p) || p.profile !== 'heyi'
    || Object.keys(p).some(k => !['profile',...names].includes(k)) || names.some(k => typeof p[k] !== 'string')) throw fault('INVALID_REQUEST');
  if (method === 'transferPrepare') {
    for (const key of ['recipient','tokenAddress']) {
      try { if (getAddress(p[key]) === ZERO) throw Error(); } catch { throw fault('INVALID_ADDRESS'); }
    }
    if (same(p.recipient, NATIVE) || !/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(p.amount)
      || p.amount.length > 115 || !/[1-9]/.test(p.amount)) throw fault('INVALID_AMOUNT');
  }
  if (names.includes('intentId') && !UUID.test(p.intentId)) throw fault('INVALID_INTENT');
  if (names.includes('previewId') && !UUID.test(p.previewId)) throw fault('INVALID_PREVIEW');
  if (names.includes('txHash') && !HASH.test(p.txHash)) throw fault('INVALID_TRANSACTION_HASH');
}

export function createWalletTransfer({ cli = createFastTradeCli(), rpc = createFlapRpc({timeoutMs:8000}),
  journal = new FlapJournal(fileURLToPath(new URL('../.private/flap/operations/', import.meta.url))),
  allowWrites = false, clock = Date.now } = {}) {
  const previews = new Map();
  let active = false, lastWallet = { connected:false, chainId:'56' };
  async function wallet({ unlocked = false } = {}) {
    if ((await cli.status()).status !== 'CONNECTED') {
      lastWallet = {connected:false,chainId:'56'};
      if (unlocked) throw fault('LOGIN_REQUIRED');
      return lastWallet;
    }
    const addresses = (await cli.addresses()).addresses.filter(a => a.binanceChainId === '56');
    if (addresses.length !== 1) throw fault('WALLET_ADDRESS_UNAVAILABLE');
    let address; try { address = getAddress(addresses[0].address); if(address === ZERO) throw Error(); }
    catch { throw fault('WALLET_ADDRESS_UNAVAILABLE'); }
    lastWallet = {connected:true,chainId:'56',address};
    if (unlocked && (await cli.txLock('56')).status !== 'UNLOCKED') throw fault('WALLET_LOCKED');
    return lastWallet;
  }
  async function latest() {
    const rows = (await journal.all()).sort((a,b) => b.createdAt-a.createdAt);
    return rows.find(x => !TERMINAL.has(x.status)) || rows.find(x=>x.action==='transfer') || null;
  }
  async function snapshot(p, address) {
    if (BigInt(await rpc('eth_chainId', [])) !== 56n) throw fault('WRONG_NETWORK');
    const block = await rpc('eth_blockNumber', []);
    const [head, native, nonce, pending] = await Promise.all([
      rpc('eth_getBlockByNumber',[block,false]), rpc('eth_getBalance',[address,block]),
      rpc('eth_getTransactionCount',[address,block]), rpc('eth_getTransactionCount',[address,'pending'])]);
    const observed = Number(BigInt(head?.timestamp || '0x0'))*1000;
    if (head?.number !== block || clock()-observed > 60000 || observed-clock() > 5000) throw fault('STALE_BLOCK');
    if (nonce !== pending) throw fault('PENDING_TRANSACTION');
    const tokenAddress = getAddress(p.tokenAddress), recipient = getAddress(p.recipient);
    if (same(address, recipient)) throw fault('SELF_TRANSFER');
    const isNative = same(tokenAddress,NATIVE);
    let decimals = 18, symbol = 'BNB', balanceRaw = BigInt(native), codeHash = null;
    async function call(method,args=[]) {
      const data=await rpc('eth_call',[{to:tokenAddress,data:transferAbi.encodeFunctionData(method,args)},block]);
      return transferAbi.decodeFunctionResult(method,data)[0];
    }
    if (!isNative) {
      const code = await rpc('eth_getCode',[tokenAddress,block]);
      if (!/^0x[\da-f]+$/i.test(code || '') || code === '0x0') throw fault('TOKEN_NOT_CONTRACT');
      codeHash = keccak256(code);
      decimals = Number(await call('decimals'));
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw fault('TOKEN_DECIMALS_UNSUPPORTED');
      try { const name=await call('symbol'); symbol=/^[A-Za-z0-9 ._-]{1,24}$/.test(name)?name:'自定义代币'; }
      catch { symbol='自定义代币'; }
      balanceRaw = await call('balanceOf',[address]);
      // CLI 1.11.0 rescales some RWA amounts. Its JSON hides that metadata.
      // Require wallet display units to agree exactly with on-chain ERC-20 units;
      // otherwise this generic transfer page cannot safely confirm the amount.
      const reported=await cli.transferBalance(tokenAddress);
      try { if(parseUnits(reported,decimals)!==balanceRaw) throw Error(); }
      catch {throw fault('TOKEN_UNIT_MISMATCH');}
    }
    if ((p.amount.split('.')[1]?.length || 0) > decimals) throw fault('AMOUNT_PRECISION');
    let amountRaw; try { amountRaw=parseUnits(p.amount,decimals); } catch { throw fault('INVALID_AMOUNT'); }
    if (amountRaw <= 0n || amountRaw >= 1n << 256n || amountRaw>10n**BigInt(decimals+18)) throw fault('INVALID_AMOUNT');
    if (amountRaw > balanceRaw) throw fault('INSUFFICIENT_BALANCE');
    const tx = {from:address,to:isNative?recipient:tokenAddress,value:isNative?'0x'+amountRaw.toString(16):'0x0',
      data:isNative?'0x':transferAbi.encodeFunctionData('transfer',[recipient,amountRaw])};
    const gas = BigInt(await rpc('eth_estimateGas',[tx]));
    const price = BigInt(await rpc('eth_gasPrice',[]));
    if (gas < 21000n || gas > 15000000n || price <= 0n) throw fault('GAS_ESTIMATE_FAILED');
    const feeRaw = gas*price;
    const reserveRaw = feeRaw*2n > 100000000000000n ? feeRaw*2n : 100000000000000n;
    if (BigInt(native) < reserveRaw+(isNative?amountRaw:0n)) throw fault('INSUFFICIENT_GAS');
    return {chainId:'56',wallet:address,recipient,tokenAddress,amount:formatUnits(amountRaw,decimals),amountRaw:amountRaw.toString(),
      decimals,symbol,balance:formatUnits(balanceRaw,decimals),nativeBalance:formatUnits(BigInt(native),18),
      estimatedFee:formatUnits(feeRaw,18),gasReserve:formatUnits(reserveRaw,18),nonce,codeHash,
      tx:{from:address,to:tx.to,value:tx.value,inputData:tx.data}};
  }
  async function save(op) { op.updatedAt=clock(); await journal.save(op); return op; }
  async function reconcile(op, suppliedHash) {
    if (!op || op.action !== 'transfer' || TERMINAL.has(op.status)) return op;
    const step=op.steps.at(-1);
    if (!step || !step.plan || !step.tx) throw fault('JOURNAL_INVALID');
    const hash=step.txHash || suppliedHash || await pendingContractHash({cli,rpc,op});
    if (!hash) return op;
    if (BigInt(await rpc('eth_chainId',[]))!==56n) throw fault('WRONG_NETWORK');
    const tx=await rpc('eth_getTransactionByHash',[hash]);
    if (!tx) { if(suppliedHash) throw fault('TRANSACTION_NOT_FOUND'); return op; }
    if (!same(tx.hash,hash) || !same(tx.from,op.wallet) || !same(tx.to,step.tx.to)
      || !same(tx.input,step.tx.inputData) || BigInt(tx.value)!==BigInt(step.tx.value)
      || BigInt(tx.nonce)!==BigInt(step.plan.nonce)) throw fault('TRANSFER_IDENTITY_MISMATCH');
    if (!step.txHash) {step.txHash=hash;step.status='SUBMITTED';op.status='SUBMITTED';op.txHash=hash;await save(op);}
    const rec=await rpc('eth_getTransactionReceipt',[hash]);
    if (!rec) return op;
    if (!same(rec.transactionHash,hash) || rec.blockHash!==tx.blockHash || !same(rec.from,op.wallet)
      || !same(rec.to,step.tx.to) || !HASH.test(rec.blockHash || '') || !/^0x[\da-f]+$/i.test(rec.blockNumber || '')) throw fault('RECEIPT_IDENTITY_MISMATCH');
    if (Number(BigInt(await rpc('eth_blockNumber',[]))-BigInt(rec.blockNumber)) < 2) return op;
    if((await rpc('eth_getBlockByNumber',[rec.blockNumber,false]))?.hash!==rec.blockHash)throw fault('RECEIPT_IDENTITY_MISMATCH');
    const gasRaw=(BigInt(rec.gasUsed)*BigInt(rec.effectiveGasPrice)).toString();
    if (BigInt(rec.status) === 0n) {
      step.status='FAILED';step.failedReceipt={txHash:hash,blockHash:rec.blockHash,blockNumber:rec.blockNumber,status:'0x0',gasRaw};
      op.status='FAILED';op.message='转账在链上失败，网络费可能已扣除。';
    } else if (BigInt(rec.status) === 1n) {
      let received=BigInt(step.plan.amountRaw);
      if (!same(step.plan.tokenAddress,NATIVE)) {
        received=0n;
        for(const log of rec.logs || []) if(same(log.address,step.plan.tokenAddress)) {
          try { const e=transferAbi.parseLog(log); if(e?.name==='Transfer' && same(e.args.from,op.wallet) && same(e.args.to,step.plan.recipient)) received+=e.args.value; } catch { /* unrelated event */ }
        }
        if(received<=0n || received>BigInt(step.plan.amountRaw)) throw fault('TRANSFER_RECEIPT_MISMATCH');
      }
      step.status='CONFIRMED';step.blockNumber=rec.blockNumber;step.gasRaw=gasRaw;
      op.status='COMPLETE';op.receivedAmount=formatUnits(received,step.plan.decimals);
      op.message=`转出已确认，收款地址收到 ${op.receivedAmount} ${step.plan.symbol}。`;
    } else throw fault('INVALID_RECEIPT_STATUS');
    return save(op);
  }
  async function status() {
    const walletState=active?lastWallet:await wallet();
    let operation=await latest();
    if (!active && operation?.action==='transfer' && !TERMINAL.has(operation.status)) {
      try { operation=await journal.exclusive(async()=>reconcile(await journal.read(operation.intentId))); }
      catch(e) { if(e.code!=='UNRESOLVED_TRADE_LOCK') return {wallet:walletState,operation,reconcileError:cleanError(e)}; }
    }
    return {wallet:walletState,operation};
  }
  async function prepare(p) {
    const unresolved=(await journal.all()).find(x=>!TERMINAL.has(x.status));
    if(unresolved) throw fault('UNRESOLVED_TRADE_EXISTS');
    const w=await wallet({unlocked:true});
    const plan=await snapshot(p,w.address);
    const preview={...plan,previewId:randomUUID(),expiresAt:clock()+60000};
    previews.clear();previews.set(preview.previewId,preview);
    return {wallet:w,transferPreview:preview};
  }
  async function transfer(p) {
    if (!allowWrites) throw noSubmission(fault('WRITES_DISABLED'));
    if (active) throw noSubmission(fault('WALLET_BUSY'));
    const preview=previews.get(p.previewId);
    if (!preview || preview.used || clock()>=preview.expiresAt) throw noSubmission(fault('PREVIEW_EXPIRED'));
    preview.used=true;active=true;
    let started=false;
    try { return await journal.exclusive(async()=>{
      const existing=await journal.read(p.intentId); if(existing) return {operation:existing};
      if ((await journal.all()).some(x=>!TERMINAL.has(x.status))) throw fault('UNRESOLVED_TRADE_EXISTS');
      const w=await wallet({unlocked:true});
      if (!same(w.address,preview.wallet)) throw fault('WALLET_CHANGED');
      const fresh=await snapshot(preview,w.address);
      if(clock()>=preview.expiresAt || fresh.nonce!==preview.nonce || fresh.decimals!==preview.decimals || fresh.codeHash!==preview.codeHash) throw fault('PREVIEW_EXPIRED');
      const now=clock();
      const step={action:'transfer',status:'SUBMITTING',startedAt:now,tx:preview.tx,plan:{...preview,used:undefined}};
      const op={intentId:p.intentId,action:'transfer',status:'SUBMITTING',createdAt:now,deadlineAt:preview.expiresAt,
        wallet:preview.wallet,market:preview.tokenAddress,steps:[step],message:'正在提交转出，请勿重复点击。'};
      await journal.save(op,{create:true});started=true;
      try {
        const result=await cli.sendTransfer({chainId:'56',tokenAddress:preview.tokenAddress,recipient:preview.recipient,amount:preview.amount});
        if(result.outcome==='REJECTED' && result.submitted===false) {
          step.status='REJECTED';op.status='REJECTED';op.error={code:result.code};op.message='转出未提交，请检查币安地址簿与钱包状态。';
        } else if(result.outcome==='SUBMITTED' && HASH.test(result.data?.txHash || '')) {
          step.status='SUBMITTED';step.txHash=result.data.txHash;op.txHash=step.txHash;op.status='SUBMITTED';op.message='转出已广播，等待链上确认。';
        } else {step.status='UNKNOWN';op.status='UNKNOWN';op.message='提交结果待核验，请在币安 App 查看记录，切勿重复转出。';}
      } catch {step.status='UNKNOWN';op.status='UNKNOWN';op.message='提交结果待核验，请在币安 App 查看记录，切勿重复转出。';}
      await save(op);return {wallet:w,operation:op};
    }); } catch(e) {throw started?e:noSubmission(e);} finally {active=false;}
  }
  return { async handle(method,p) {
    validateTransferFields(method,p);
    if(method==='walletStatus') return status();
    if(method==='transferPrepare') return prepare(p);
    if(method==='transfer') return transfer(p);
    if(method==='transferReconcile') return journal.exclusive(async()=>{
      const op=await journal.read(p.intentId);
      if(!op || op.action!=='transfer') throw fault('INVALID_INTENT');
      return {operation:await reconcile(op,p.txHash)};
    });
  }};
}
