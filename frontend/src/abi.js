// ABIs mínimos en formato legible por ethers v6 (human-readable ABI)
export const VAULT_ABI = [
  "function totalAssets() view returns (uint256)",
  "function idleAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function paused() view returns (bool)",
  "function performanceFeeBps() view returns (uint16)",
  "function treasury() view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function OPERATOR_ROLE() view returns (bytes32)",
  "function GUARDIAN_ROLE() view returns (bytes32)",
  "function strategyInfo(address) view returns (bool registered, bool active, uint16 maxAllocationBps, uint128 debt)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function allocate(address strategy, uint256 amount)",
  "function recall(address strategy, uint256 amount)",
  "function harvest()",
  "function checkStrategyHealth(address strategy) returns (bool)",
  "function pause()",
  "function emergencyRecallAll()",
];

export const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet()",
];

export const STRATEGY_ABI = [
  "function totalAssets() view returns (uint256)",
  "function BOT_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function executeTrade(int256 pnl)",
];
