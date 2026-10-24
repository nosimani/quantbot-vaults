/**
 * Demo del flujo principal de QuantBot Vaults, ejecutado de principio a fin on-chain:
 *   faucet -> approve -> deposit -> allocate (bot) -> trade con ganancia (bot) -> harvest (fee)
 *   -> health check -> recall -> redeem
 * Imprime y guarda los hashes de transacción (evidencia para README y video).
 *
 * Uso local:    npx hardhat run scripts/demo.js
 * Uso testnet:  npx hardhat run scripts/demo.js --network sepolia   (requiere deploy previo)
 * La cuenta del .env debe tener OPERATOR_ROLE/BOT_ROLE (por defecto, el deployer los tiene).
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployAll } = require("./deploy");

async function main() {
  const { ethers, network } = hre;
  const isLocal = network.name === "hardhat" || network.name === "localhost";
  const [signer] = await ethers.getSigners();

  const deployment = isLocal
    ? await deployAll({ log: () => {} })
    : JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));

  const { vault: v, strategy: s, asset: a } = deployment.contracts;
  const token = await ethers.getContractAt("MockUSDC", a.address);
  const vault = await ethers.getContractAt("QuantBotVault", v.address);
  const strategy = await ethers.getContractAt("MockTradingStrategy", s.address);
  const explorer = deployment.explorer;
  const fmt = (x) => ethers.formatUnits(x, 6);
  const usdc = (n) => ethers.parseUnits(String(n), 6);

  const isOperator = await vault.hasRole(await vault.OPERATOR_ROLE(), signer.address);
  const isBot = await strategy.hasRole(await strategy.BOT_ROLE(), signer.address);
  if (!isOperator || !isBot) {
    throw new Error("La cuenta firmante necesita OPERATOR_ROLE (vault) y BOT_ROLE (estrategia) para correr la demo.");
  }

  const evidence = [];
  const step = async (label, txPromise) => {
    const tx = await txPromise;
    const receipt = await tx.wait();
    const link = explorer ? `${explorer}/tx/${receipt.hash}` : receipt.hash;
    evidence.push({ step: label, txHash: receipt.hash, block: receipt.blockNumber, link });
    console.log(`✔ ${label}\n    ${link}`);
    return receipt;
  };

  console.log(`\n=== DEMO QuantBot Vaults en ${network.name} ===`);
  console.log(`Cuenta: ${signer.address}\n`);

  // 1) Fondos de prueba: faucet (si hay cooldown, se asume que ya hay saldo)
  if ((await token.balanceOf(signer.address)) < usdc(2000)) {
    await step("1. Faucet de mUSDC", token.faucet());
  }

  // 2) Aprobar y depositar
  await step("2. Approve del vault", token.approve(v.address, ethers.MaxUint256));
  const sharesBefore = await vault.balanceOf(signer.address);
  await step("3. Depósito de 1000 mUSDC", vault.deposit(usdc(1000), signer.address));
  // Shares propias de este depósito (si el treasury es la misma cuenta, no se mezclan con las del fee)
  const userShares = (await vault.balanceOf(signer.address)) - sharesBefore;

  // 3) El bot asigna capital a la estrategia
  const total = await vault.totalAssets();
  const toAllocate = total / 2n; // 50 % (igual al tope configurado por defecto)
  await step(`4. Bot asigna ${fmt(toAllocate)} mUSDC a la estrategia`, vault.allocate(s.address, toAllocate));

  // 4) El bot reporta ganancia de 50 mUSDC
  await step("5. Approve de la estrategia", token.approve(s.address, ethers.MaxUint256));
  await step("6. Bot reporta ganancia de +50 mUSDC", strategy.executeTrade(usdc(50)));
  console.log(`    totalAssets del vault: ${fmt(await vault.totalAssets())} mUSDC`);

  // 5) Comisión de performance y control de salud
  await step("7. Harvest (cobro de fee de performance)", vault.harvest());
  await step("8. Health check de la estrategia (circuit breaker)", vault.checkStrategyHealth(s.address));

  // 6) Recuperar capital y retirar
  const inStrategy = await strategy.totalAssets();
  await step(`9. Recall de ${fmt(inStrategy)} mUSDC`, vault.recall(s.address, inStrategy));

  const before = await token.balanceOf(signer.address);
  await step("10. Redeem de las shares del depósito", vault.redeem(userShares, signer.address, signer.address));
  const after = await token.balanceOf(signer.address);

  console.log(`\nRetiro recibido: ${fmt(after - before)} mUSDC (depositó 1000; ganancia neta de fee)`);
  console.log(`Shares del treasury (fee): ${ethers.formatUnits(await vault.balanceOf(deployment.roles.treasury), 9)}`);

  if (!isLocal) {
    const out = path.join(__dirname, "..", "deployments", `${network.name}-demo.json`);
    fs.writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), evidence }, null, 2));
    console.log(`\nEvidencia guardada en ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
