/**
 * Verifica en el explorer (Etherscan) todos los contratos propios desplegados
 * leyendo deployments/<red>.json. Imprime la URL directa al código verificado.
 *
 * Uso:  npx hardhat run scripts/verify.js --network sepolia
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function verifyOne(label, address, constructorArguments, explorer) {
  try {
    await hre.run("verify:verify", { address, constructorArguments });
    console.log(`✔ ${label} verificado`);
  } catch (e) {
    if (/already verified/i.test(e.message)) {
      console.log(`✔ ${label} ya estaba verificado`);
    } else {
      console.error(`✘ ${label}: ${e.message}`);
      process.exitCode = 1;
      return;
    }
  }
  if (explorer) console.log(`   ${explorer}/address/${address}#code`);
}

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No existe ${file}. Ejecutá primero scripts/deploy.js en esta red.`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  if (d.contracts.asset.isMock) {
    await verifyOne("MockUSDC", d.contracts.asset.address, d.contracts.asset.constructorArgs, d.explorer);
  }
  await verifyOne("QuantBotVault", d.contracts.vault.address, d.contracts.vault.constructorArgs, d.explorer);
  await verifyOne("MockTradingStrategy", d.contracts.strategy.address, d.contracts.strategy.constructorArgs, d.explorer);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
