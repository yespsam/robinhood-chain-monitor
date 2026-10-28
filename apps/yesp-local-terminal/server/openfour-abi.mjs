// ABI subset from four-meme-community/openfour-docs commit 6e1b1c3a3c77be383784e23f5f01198d34690f1e.
import {Interface} from 'ethers';
export const coreAbi=new Interface([
  "function buy(address token, uint256 amount, uint256 maxQuoteAmount, uint256 options, bytes proof) payable",
  "event TradeExecuted(address indexed token, address indexed trader, uint256 indexed presetId, bool isBuy, address quoteAsset, address vault, uint256 requestedTokenAmount, uint256 tokenAmount, uint256 curveQuoteAmount, uint256 traderQuoteAmount, uint256 lastPrice, uint256 slippageLimit, uint256 protocolFee, uint256 taxFee, uint256 devFee, uint256 antiSniperFee, uint256 totalRaised, uint256 remainingForSale)",
  "function buyByBudget(address token, uint256 maxPayAmount, uint256 minAmountOut, uint256 options, bytes proof) payable",
  "function feeRouter() view returns (address)",
  "function paused() view returns (bool)",
  "function registry() view returns (address)",
  "function sell(address token, uint256 amount, uint256 minReceiveAmount, uint256 options, bytes proof)",
  "function tokens(address) view returns (uint32 version, address creator, uint256 presetId, address token, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address tokenModule, address customData, uint256 createBlock, bool exists, bool paused, bool antiSniperEnabled)",
  "function wrappedNative() view returns (address)"
]);
export const toolsAbi=new Interface([
  "function estimateBuy(address token, address trader, uint256 amount, uint256 options, bytes proof) returns ((uint256 curveQuote, uint256 totalFee, uint256 userPays, uint256 userReceives, uint256 tokenAmount, uint256 executionPrice))",
  "function core() view returns (address)",
  "function estimateBuyByBudget(address token, address trader, uint256 maxPayAmount, uint256 options, bytes proof) returns ((uint256 curveQuote, uint256 totalFee, uint256 userPays, uint256 userReceives, uint256 tokenAmount, uint256 executionPrice) estimate)",
  "function estimateSell(address token, address trader, uint256 amount, uint256 options, bytes proof) returns ((uint256 curveQuote, uint256 totalFee, uint256 userPays, uint256 userReceives, uint256 tokenAmount, uint256 executionPrice))"
]);
export const registryAbi=new Interface([
  "function getModuleBeacon(bytes32 moduleKey) view returns (address)",
  "function getPreset(uint256 presetId) view returns ((uint256 id, string name, string description, string version, bool active, bool createEnabled, address validator, bytes32 tokenModuleId, bytes32 vaultModuleId, bytes32 curveModuleId, bytes32 tradeModuleId, bytes32 migrateModuleId, bytes32 tokenImplId, bytes32 customDataId, address author))",
  "function getPresetTokenImpl(uint256 presetId) view returns (address)",
  "function openFourCore() view returns (address)",
  "function openFourTool() view returns (address)"
]);
export const feeAbi=new Interface([
  "function feeConfig() view returns (uint16 protocolFeeBps, uint16 developerFeePoolBps, uint16 maxProtocolDevFeeBps, uint16 maxTaxBps, uint8 maxTaxTiers, uint256 partnerProtocolShareBps, uint256 placeholder2, uint256 placeholder3, uint256 placeholder4, uint256 placeholder5, uint256 placeholder6)"
]);
