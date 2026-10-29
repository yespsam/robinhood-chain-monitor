import { Sessions } from './auth.mjs';
import { createApplication } from './app.mjs';
import { OfficialWallet, createCliRunner } from './official-cli.mjs';
import { walletChildEnvironment } from './cli-network.mjs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createManualCli, evaluateTargetAudit } from './manual-cli.mjs';
import { ManualTradeService } from './manual-trade.mjs';
import { FlapMintService } from './flap-mint.mjs';
import { createLocalAccessDirectory, writeLocalAccess, clearLocalAccess } from './local-access.mjs';
const network = await walletChildEnvironment({ enabled: true });
const port = Number(process.env.WALLET_DASHBOARD_PORT || '51769');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_LOCAL_PORT');
await createLocalAccessDirectory();
const localAccessKey = randomBytes(32).toString('hex');
const wallet = new OfficialWallet(createCliRunner({ childEnv: network.env }));
const manualCli = createManualCli({ childEnv: network.env });
const tradeWallet = Object.create(wallet);
tradeWallet.txLock = manualCli.txLock;
tradeWallet.gasPrice = manualCli.gasPrice;
const app = await createApplication({ sessions: new Sessions(), wallet, localAccess: true, walletAccess: true, localAccessKey, port,
  manualTradeFactory: ({ gate }) => new ManualTradeService({ wallet: tradeWallet, gate,
    executeSwap: manualCli.executeSwap, readOrder: manualCli.readOrder, auditTarget: evaluateTargetAudit,
    journalDir: fileURLToPath(new URL('../.private/trades/', import.meta.url)) }),
  mintFactory: ({ gate }) => new FlapMintService({ wallet: tradeWallet, gate,
    previewContractCall: manualCli.previewContractCall, executeContractCall: manualCli.executeContractCall,
    journalDir: fileURLToPath(new URL('../.private/mints/', import.meta.url)) }) });
await writeLocalAccess(app.origin, localAccessKey);
console.log(`YESP Wallet 本机看板：${app.origin}`);
console.log('请通过 npm run open 或打开钱包.command 进入；Swap 与 Flap Mint 均需在看板审阅并逐笔确认。');
console.log('CLI network mode: ' + network.mode);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await clearLocalAccess(); await app.close(); process.exit(0); });
