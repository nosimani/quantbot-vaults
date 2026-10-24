const { ethers } = require("hardhat");

/** Convierte un número entero/decimal a unidades de 6 decimales (mUSDC). */
const usdc = (n) => ethers.parseUnits(n.toString(), 6);

const FEE_BPS = 2000; // 20 % de comisión de performance
const DEPOSIT_CAP = usdc(1_000_000);
const MIN_IDLE_BPS = 1000; // 10 % siempre líquido
const MAX_DRAWDOWN_BPS = 1000; // 10 % de pérdida dispara el circuit breaker
const STRATEGY_CAP_BPS = 5000; // máx. 50 % del vault en la estrategia
const MAX_LOSS_PER_TRADE_BPS = 2000; // el bot no puede perder más de 20 % por operación

/**
 * Despliega el protocolo completo y deja roles configurados:
 *  - owner: admin del vault y de la estrategia
 *  - operator: OPERATOR_ROLE en el vault y BOT_ROLE en la estrategia (el "bot")
 *  - guardian: GUARDIAN_ROLE en el vault
 */
async function deployFixture() {
  const [owner, operator, guardian, treasury, alice, bob, attacker] = await ethers.getSigners();

  const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
  const tokenAddr = await token.getAddress();

  const Vault = await ethers.getContractFactory("QuantBotVault");
  const vault = await Vault.deploy(
    tokenAddr,
    "QuantBot Vault Shares",
    "qbvUSDC",
    owner.address,
    treasury.address,
    FEE_BPS,
    DEPOSIT_CAP,
    MIN_IDLE_BPS,
    MAX_DRAWDOWN_BPS
  );
  const vaultAddr = await vault.getAddress();

  const Strategy = await ethers.getContractFactory("MockTradingStrategy");
  const strategy = await Strategy.deploy(tokenAddr, vaultAddr, owner.address, MAX_LOSS_PER_TRADE_BPS);
  const strategyAddr = await strategy.getAddress();

  await vault.grantRole(await vault.OPERATOR_ROLE(), operator.address);
  await vault.grantRole(await vault.GUARDIAN_ROLE(), guardian.address);
  await strategy.grantRole(await strategy.BOT_ROLE(), operator.address);
  await vault.addStrategy(strategyAddr, STRATEGY_CAP_BPS);

  // Fondos de prueba
  for (const user of [alice, bob, operator]) {
    await token.mint(user.address, usdc(10_000));
  }
  await token.connect(alice).approve(vaultAddr, ethers.MaxUint256);
  await token.connect(bob).approve(vaultAddr, ethers.MaxUint256);
  await token.connect(operator).approve(strategyAddr, ethers.MaxUint256);

  return { owner, operator, guardian, treasury, alice, bob, attacker, token, vault, strategy, tokenAddr, vaultAddr, strategyAddr, Vault, Strategy };
}

module.exports = {
  usdc,
  deployFixture,
  FEE_BPS,
  DEPOSIT_CAP,
  MIN_IDLE_BPS,
  MAX_DRAWDOWN_BPS,
  STRATEGY_CAP_BPS,
  MAX_LOSS_PER_TRADE_BPS,
};
