/**
 * Regenera la sección "9. Red y contratos desplegados" del README a partir de
 *   deployments/<red>.json  y  deployments/<red>-demo.json
 * para que direcciones, URLs de código verificado y hashes coincidan SIEMPRE con el último despliegue.
 *
 * Uso:  node scripts/update-readme.js [red]      (por defecto: sepolia)
 * Reemplaza el texto entre <!-- DEPLOY:START --> y <!-- DEPLOY:END -->.
 */
const fs = require("fs");
const path = require("path");

const network = process.argv[2] || "sepolia";
const root = path.join(__dirname, "..");
const readFile = path.join(root, "README.md");
const dep = JSON.parse(fs.readFileSync(path.join(root, "deployments", `${network}.json`), "utf8"));
const demoFile = path.join(root, "deployments", `${network}-demo.json`);
const demo = fs.existsSync(demoFile) ? JSON.parse(fs.readFileSync(demoFile, "utf8")) : null;

const ex = dep.explorer;
const row = (name, c) => `| ${name} | \`${c.address}\` | ${ex}/address/${c.address}#code |`;

let md = `**Red:** ${network === "sepolia" ? "Sepolia" : network} (chainId ${dep.chainId})\n\n`;
md += "| Contrato | Dirección | Código verificado |\n|---|---|---|\n";
md += [
  row("MockUSDC", dep.contracts.asset),
  row("QuantBotVault", dep.contracts.vault),
  row("MockTradingStrategy", dep.contracts.strategy),
].join("\n");
md += `\n\nPeríodo de liberación de ganancias configurado en el despliegue: **${dep.profitUnlockPeriod ?? "?"} s**.\n`;

if (demo) {
  md += "\n**Transacciones reales del flujo principal** (salida de `npm run demo:sepolia`):\n\n| Paso | Transacción |\n|---|---|\n";
  for (const e of demo.evidence) {
    md += `| ${e.step} | [${e.txHash.slice(0, 12)}…](${e.link}) |\n`;
  }
}

const readme = fs.readFileSync(readFile, "utf8");
const start = "<!-- DEPLOY:START -->";
const end = "<!-- DEPLOY:END -->";
const a = readme.indexOf(start);
const b = readme.indexOf(end);
if (a === -1 || b === -1) throw new Error("Faltan los marcadores DEPLOY:START / DEPLOY:END en el README.");
fs.writeFileSync(readFile, `${readme.slice(0, a + start.length)}\n\n${md}\n${readme.slice(b)}`);
console.log("README actualizado con el último despliegue.");
