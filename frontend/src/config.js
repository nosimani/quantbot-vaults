// Configuración leída de variables VITE_* (ver frontend/.env.example)
export const CONFIG = {
  chainId: Number(import.meta.env.VITE_CHAIN_ID || 11155111),
  explorer: import.meta.env.VITE_EXPLORER || "",
  vault: import.meta.env.VITE_VAULT_ADDRESS || "",
  asset: import.meta.env.VITE_ASSET_ADDRESS || "",
  strategy: import.meta.env.VITE_STRATEGY_ADDRESS || "",
  // RPC público de solo lectura: permite ver el vault sin conectar wallet
  rpcUrl: import.meta.env.VITE_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  repo: import.meta.env.VITE_REPO_URL || "https://github.com/nosimani/quantbot-vaults",
};

export const isConfigured = () => Boolean(CONFIG.vault && CONFIG.asset && CONFIG.strategy);
