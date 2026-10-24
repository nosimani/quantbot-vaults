/**
 * Despliega el protocolo QuantBot Vaults:
 *   MockUSDC (si no se define ASSET_ADDRESS) -> QuantBotVault -> MockTradingStrategy
 * y configura roles. Guarda direcciones y argumentos de constructor en deployments/<red>.json
 * (usado luego por scripts/verify.js y scripts/demo.js).
 *
 * Uso:  npx hardhat run scripts/deploy.js --network sepolia
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const EXPLORERS = {
  1: "https://etherscan.io",
  11155111: "https://sepolia.etherscan.io",
};

async function deployAll({ log = console.log } = {}) {
  const { ethers, network } = hre;
  const env = process.env;
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  log(`Red: ${network.name} (chainId ${chainId}) | Deployer: ${deployer.address}`);

  // --- Activo subyacente --------------------------------------------------
  let tokenAddr = env.ASSET_ADDRESS && env.ASSET_ADDRESS.trim() !== "" ? env.ASSET_ADDRESS.trim() : null;
  let deployedMockToken = false;
  if (!tokenAddr) {
    const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
    await token.waitForDeployment();
    tokenAddr = await token.getAddress();
    deployedMockToken = true;
    log(`MockUSDC desplegado en ${tokenAddr}`);
  }
  const meta = await ethers.getContractAt("IERC20Metadata", tokenAddr);
  const decimals = Number(await meta.decimals());

  // --- Parámetros ---------------------------------------------------------
  const treasury = env.TREASURY_ADDRESS && env.TREASURY_ADDRESS.trim() !== "" ? env.TREASURY_ADDRESS.trim() : deployer.address;
  const operator = env.OPERATOR_ADDRESS && env.OPERATOR_ADDRESS.trim() !== "" ? env.OPERATOR_ADDRESS.trim() : deployer.address;
  const guardian = env.GUARDIAN_ADDRESS && env.GUARDIAN_ADDRESS.trim() !== "" ? env.GUARDIAN_ADDRESS.trim() : deployer.address;
  const feeBps = Number(env.PERFORMANCE_FEE_BPS || 2000);
  const minIdleBps = Number(env.MIN_IDLE_BPS || 1000);
  const maxDrawdownBps = Number(env.MAX_DRAWDOWN_BPS || 1000);
  const strategyCapBps = Number(env.STRATEGY_CAP_BPS || 5000);
  const maxLossPerTradeBps = Number(env.MAX_LOSS_PER_TRADE_BPS || 2000);
  const depositCap = ethers.parseUnits(env.DEPOSIT_CAP || "1000000", decimals);

  // --- Vault --------------------------------------------------------------
  const vaultArgs = [
    tokenAddr,
    "QuantBot Vault Shares",
    "qbvUSD",
    deployer.address,
    treasury,
    feeBps,
    depositCap.toString(),
    minIdleBps,
    maxDrawdownBps,
  ];
  const vault = await (await ethers.getContractFactory("QuantBotVault")).deploy(...vaultArgs);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  log(`QuantBotVault desplegado en ${vaultAddr}`);

  // --- Estrategia ---------------------------------------------------------
  const strategyArgs = [tokenAddr, vaultAddr, deployer.address, maxLossPerTradeBps];
  const strategy = await (await ethers.getContractFactory("MockTradingStrategy")).deploy(...strategyArgs);
  await strategy.waitForDeployment();
  const strategyAddr = await strategy.getAddress();
  log(`MockTradingStrategy desplegada en ${strategyAddr}`);

  // --- Roles y registro de la estrategia -----------------------------------
  await (await vault.grantRole(await vault.OPERATOR_ROLE(), operator)).wait();
  await (await vault.grantRole(await vault.GUARDIAN_ROLE(), guardian)).wait();
  await (await strategy.grantRole(await strategy.BOT_ROLE(), operator)).wait();
  await (await vault.addStrategy(strategyAddr, strategyCapBps)).wait();
  log(`Roles configurados | operator/bot: ${operator} | guardian: ${guardian}`);

  const explorer = EXPLORERS[chainId] || null;
  const result = {
    network: network.name,
    chainId,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    explorer,
    contracts: {
      asset: { address: tokenAddr, isMock: deployedMockToken, constructorArgs: [] },
      vault: { address: vaultAddr, constructorArgs: vaultArgs },
      strategy: { address: strategyAddr, constructorArgs: strategyArgs },
    },
    roles: { admin: deployer.address, operator, guardian, treasury },
  };

  if (network.name !== "hardhat") {
    const dir = path.join(__dirname, "..", "deployments");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${network.name}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    log(`Direcciones guardadas en ${file}`);
    if (explorer) {
      log(`Código (tras verificar): ${explorer}/address/${vaultAddr}#code`);
    }
  }
  return result;
}

if (require.main === module) {
  deployAll()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { deployAll, EXPLORERS };
