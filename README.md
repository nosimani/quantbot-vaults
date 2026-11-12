# QuantBot Vaults

**Protocolo de bóvedas automatizadas en Solidity para la ejecución segura de estrategias de trading algorítmico y bots en mercados Fintech on-chain**

> Proyecto Final — Desarrollo Web3 / Solidity (nivel avanzado). Hardhat · OpenZeppelin 5 · ERC-4626 · React + ethers v6.

---

## Tabla de contenidos

1. [Qué hace el proyecto](#1-qué-hace-el-proyecto)
2. [Por qué blockchain](#2-por-qué-blockchain-análisis-de-la-solución)
3. [Arquitectura](#3-arquitectura)
4. [Estructura del repositorio](#4-estructura-del-repositorio)
5. [Instalación y compilación](#5-instalación-y-compilación)
6. [Tests y coverage](#6-tests-y-coverage)
7. [Análisis estático con Slither](#7-análisis-estático-con-slither)
8. [Cómo ejecutar el proyecto (deploy, verificación, demo, frontend)](#8-cómo-ejecutar-el-proyecto)
9. [Red y contratos desplegados](#9-red-y-contratos-desplegados)
10. [Seguridad: decisiones de diseño](#10-seguridad-decisiones-de-diseño)
11. [Limitaciones conocidas del MVP](#11-limitaciones-conocidas-del-mvp)
12. [Roadmap](#12-roadmap)

---

## 1. Qué hace el proyecto

QuantBot Vaults es una **bóveda ERC-4626** donde los usuarios depositan un token (en la demo, `mUSDC`) y reciben *shares*. Un **operador (el bot de trading)** puede asignar parte de ese capital a **estrategias whitelisteadas**, pero el protocolo aplica **límites de riesgo on-chain** que el bot no puede saltarse:

| Control | Qué impide |
|---|---|
| Whitelist de estrategias | El bot no puede enviar fondos a una dirección arbitraria; solo a estrategias registradas por el admin, que además deben usar el mismo activo y apuntar a este vault. |
| Tope por estrategia (`maxAllocationBps`) | Concentrar demasiado capital en un solo bot. |
| Reserva mínima de liquidez (`minIdleBps`) | Dejar el vault sin liquidez para retiros. |
| Circuit breaker (`maxDrawdownBps`) | Seguir asignando a una estrategia que ya perdió más de lo tolerado (cualquiera puede dispararlo, solo reduce riesgo). |
| Pausa / `emergencyRecallAll` (rol guardián) | Daño prolongado ante un incidente: pausa depósitos y recupera todo el capital posible. **Los retiros nunca se bloquean por la pausa.** |
| Liberación gradual de ganancias (`profitUnlockPeriod`) | Que alguien deposite justo antes de una ganancia y retire justo después para quedarse con rendimiento ajeno. Las ganancias se reconocen al reportarse, se bloquean y se liberan linealmente. |
| Pérdidas reconocidas de inmediato | Que alguien retire a precio viejo después de una pérdida. Las pérdidas bajan `totalAssets` en el acto, consumen primero la ganancia bloqueada, dan de baja la deuda y activan el circuit breaker. |
| Fee de performance con *high-water mark* | Cobrar comisión dos veces sobre la misma ganancia o cobrar sobre depósitos nuevos. Se paga acuñando shares al treasury. |
| Tope de depósitos (`depositCap`) | Exposición excesiva durante la fase MVP. |

**Flujo principal (el que se muestra en la demo):**

```
usuario ──deposit──▶ Vault ──allocate (bot)──▶ Strategy
                        ▲                          │ executeTrade(+pnl) ─▶ el vault reconoce la ganancia,
                        │                          │                        la BLOQUEA y la libera linealmente
                        └────── recall ◀───────────┘
usuario ◀─redeem (capital + ganancia liberada − fee)─ Vault     harvest ─▶ mint de shares de fee al treasury
```

---

## 2. Por qué blockchain (análisis de la solución)

Un fondo gestionado por un bot tiene un problema de confianza: el usuario entrega su capital a un tercero y no puede verificar qué hace con él. Blockchain aporta, de forma verificable:

- **Custodia no discrecional:** el operador *nunca* tiene los fondos en su wallet; solo puede moverlos dentro de reglas codificadas (whitelist, topes, reserva de liquidez). Un bot comprometido tiene un radio de daño acotado.
- **Transparencia y auditabilidad:** TVL, asignaciones, pérdidas y comisiones son públicas y trazables por eventos.
- **Retiros garantizados por código:** el derecho a retirar la liquidez disponible no depende de la voluntad del gestor.
- **Composabilidad:** al ser ERC-4626, la bóveda es integrable por otros protocolos, agregadores y frontends sin adaptadores.
- **Comisiones automáticas y justas:** el high-water mark es código, no una promesa contractual.

Lo que **no** resuelve (y se documenta en [limitaciones](#11-limitaciones-conocidas-del-mvp)): el desempeño del bot ocurre parcialmente off-chain, por lo que el protocolo limita el daño posible pero no garantiza rentabilidad.

---

## 3. Arquitectura

```mermaid
flowchart LR
    U[Usuario] -- deposit / redeem --> V[QuantBotVault<br/>ERC-4626 + AccessControl<br/>Pausable + ReentrancyGuard]
    B[Bot operador<br/>OPERATOR_ROLE] -- allocate / recall --> V
    G[Guardián<br/>GUARDIAN_ROLE] -- pause / emergencyRecallAll --> V
    A[Admin<br/>DEFAULT_ADMIN_ROLE] -- addStrategy / parámetros --> V
    V -- transfer / withdraw / totalAssets --> S[IStrategy<br/>MockTradingStrategy]
    BOT2[Wallet del bot<br/>BOT_ROLE] -- executeTrade pnl --> S
    V -- mint shares de fee --> T[Treasury]
    V --- TOK[(MockUSDC<br/>ERC-20)]
    S --- TOK
```

**Contratos propios (todos se despliegan y verifican):**

| Contrato | Rol |
|---|---|
| `QuantBotVault` | Núcleo. ERC-4626 + control de roles, límites de riesgo, circuit breaker, pausa, fees. |
| `IStrategy` | Interfaz mínima que cualquier adaptador de estrategia debe cumplir (`asset`, `vault`, `totalAssets`, `withdraw`). |
| `MockTradingStrategy` | Estrategia de demostración: el bot reporta PnL (ganancias aportadas con fondos reales de su wallet; pérdidas enviadas a un sumidero) con tope de pérdida por operación. Representa el "lado off-chain" del bot. |
| `MockUSDC` | Token de prueba con faucet (6 decimales). **Solo testnet.** |

**Interacción entre contratos:** `QuantBotVault` ↔ `MockTradingStrategy` (el vault transfiere fondos, lee `totalAssets()` y llama a `withdraw()`), y ambos con el ERC-20 mediante `SafeERC20`.

**Roles y permisos (documentados también en NatSpec):**

| Rol | Puede | No puede |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Registrar/remover estrategias, ajustar parámetros, reanudar (`unpause`). Recomendado: multisig. | Mover fondos de usuarios. |
| `OPERATOR_ROLE` (bot) | `allocate`, `recall`. | Enviar fondos fuera de estrategias registradas; saltarse topes/reserva; pausar/reanudar. |
| `GUARDIAN_ROLE` | `pause`, `deactivateStrategy`, `emergencyRecallAll`, `recall`. | Reanudar el vault, asignar capital. |
| Cualquiera | `harvest`, `checkStrategyHealth` (solo reducen riesgo / cobran fee pendiente). | — |

---

## 4. Estructura del repositorio

```
contracts/
  QuantBotVault.sol            # contrato principal (NatSpec completo)
  interfaces/IStrategy.sol
  strategies/MockTradingStrategy.sol
  mocks/MockUSDC.sol
test/
  QuantBotVault.test.js        # flujo principal, reverts, roles, riesgo, fees, invariante
  MockTradingStrategy.test.js
  MockUSDC.test.js
  helpers/fixture.js
scripts/
  deploy.js                    # despliega y configura roles → deployments/<red>.json
  verify.js                    # verifica en Etherscan e imprime URL del código
  demo.js                      # flujo principal completo on-chain, guarda hashes de tx
frontend/                      # React + Vite + ethers v6
docs/                          # análisis Slither, guion de video, checklist de entrega
```

---

## 5. Instalación y compilación

Requisitos: **Node.js 18+ (recomendado 20 LTS o 22)**, npm.

```bash
git clone <URL_DE_TU_REPO>
cd quantbot-vaults
npm install
cp .env.example .env        # completar solo para desplegar en testnet
npx hardhat compile
```

El compilador es `solc 0.8.24` (optimizer 200 runs, `evmVersion: cancun`). El proyecto debe compilar sin warnings relevantes.

---

## 6. Tests y coverage

```bash
npm test               # todos los tests deben pasar
npm run coverage       # reporte en consola + coverage/index.html
npm run gas            # reporte de gas (opcional)
```

Cobertura de escenarios (5 archivos):

- **Éxito del flujo principal:** depósito → allocate → ganancia del bot → harvest (fee) → recall → redeem con rendimiento.
- **Reverts / errores:** permisos (`AccessControlUnauthorizedAccount`), allocate a dirección no registrada, monto cero, liquidez insuficiente, tope por estrategia, reserva mínima, parámetros inválidos del constructor, tope de depósitos, pausa, estrategia incompatible, `MAX_STRATEGIES`, pérdida por encima del límite.
- **Riesgo:** circuit breaker por drawdown, high-water mark (sin doble cobro), depósito nuevo no se cobra como ganancia, pausa que no bloquea retiros, `emergencyRecallAll`.
- **Invariante:** lo reclamable por todos los holders nunca excede `totalAssets` en una secuencia determinística de operaciones.
- **Seguridad (`QuantBotVault.security.test.js`):** ataque de depósito/retiro oportunista (ya no deja rendimiento), liberación lineal de ganancias, `recall`/`emergencyRecallAll` que no saltean el bloqueo, pérdidas dadas de baja (sin deuda residual ni disparos espurios del circuit breaker), pérdida que consume ganancia bloqueada, `previewRedeem`/`previewWithdraw`/`previewDeposit` exactos con comisión pendiente.
- **Fuzzing e invariantes (`QuantBotVault.fuzz.test.js`):** 6 semillas × 60 operaciones aleatorias reproducibles (depósitos, retiros, asignaciones, ganancias, pérdidas, donaciones, harvest, tiempo y ataques oportunistas). Después de cada operación se verifican: solvencia, reclamable ≤ `totalAssets`, conservación de tokens, precio por share no decreciente salvo pérdidas, `previewRedeem` ≤ lo entregado, "sin almuerzo gratis" y cierre sin fondos atrapados.

> Resultados reales (cantidad de tests y coverage): ver [`docs/EVIDENCIA.md`](docs/EVIDENCIA.md). Detalle de cada corrección: [`docs/CORRECCIONES.md`](docs/CORRECCIONES.md).

---

## 7. Análisis estático con Slither

```bash
pip install slither-analyzer      # una sola vez
npm run slither                   # = slither . --config-file slither.config.json
```

La configuración (`slither.config.json`) excluye `node_modules` y `contracts/mocks`. El resultado real de la ejecución y la justificación de cada finding está en [`docs/SLITHER.md`](docs/SLITHER.md).

---

## 8. Cómo ejecutar el proyecto

### 8.1 Local (sin testnet)

```bash
npx hardhat run scripts/demo.js          # despliega en la red en memoria y corre el flujo completo
```

### 8.2 Testnet (Sepolia)

1. Completar `.env` (ver `.env.example`): `SEPOLIA_RPC_URL`, `PRIVATE_KEY` (**wallet descartable de testnet**), `ETHERSCAN_API_KEY`.
2. Conseguir ETH de Sepolia en un faucet.
3. Ejecutar:

```bash
npm run deploy:sepolia      # despliega MockUSDC, QuantBotVault, MockTradingStrategy + roles
npm run verify:sepolia      # verifica los 3 contratos e imprime la URL del código verificado
npm run demo:sepolia        # corre el flujo principal on-chain y guarda los hashes
node scripts/update-readme.js   # rellena la sección 9 del README con las direcciones y hashes reales
```

`deploy` escribe `deployments/sepolia.json` (direcciones y argumentos de constructor) y `demo` escribe `deployments/sepolia-demo.json` con los hashes y links de cada transacción. En la demo la ganancia reportada queda bloqueada y el script espera el período de liberación (`PROFIT_UNLOCK_PERIOD`, 60 s en testnet) antes de cobrar la comisión y retirar.

### 8.3 Frontend

```bash
cd frontend
npm install
cp .env.example .env     # pegar las direcciones de deployments/sepolia.json
npm run dev              # http://localhost:5173
```

La app se puede **ver sin wallet** (modo lectura con un RPC público de Sepolia) y se conecta con MetaMask para operar. Desde la UI: conectar wallet → *faucet* → aprobar → depositar → (cuenta con roles de operador/bot) asignar al bot, reportar ganancia/pérdida, reportar y cobrar fee, chequear drawdown → retirar. El panel de protección muestra la ganancia bloqueada y cuánto falta para liberarla. Los botones de operador/bot/guardián se habilitan solo si la cuenta tiene el rol on-chain. Cada transacción muestra un link al explorer.

**Frontend publicado:** https://nosimani.github.io/quantbot-vaults/ (se despliega automáticamente con GitHub Actions al hacer push a `main`; ver `.github/workflows/deploy-frontend.yml`). Alternativa: importar el repo en Vercel con *Root Directory* `frontend` y las variables `VITE_*` de `frontend/.env.example`.

### 8.4 Video de la demo

Video (máx. 5 min) con la demo del flujo principal en Sepolia: **<COMPLETAR: link al video>** (también entregado en la carpeta de entrega del Drive como `Apellido_QuantBotVaults_Video.mp4`). Guion: [`docs/GUION_VIDEO.md`](docs/GUION_VIDEO.md).

---

## 9. Red y contratos desplegados

<!-- DEPLOY:START -->
(se completa con `node scripts/update-readme.js` después de desplegar y correr la demo)
<!-- DEPLOY:END -->

---

## 10. Seguridad: decisiones de diseño

- **Ganancias graduales (anti depósito/retiro oportunista).** `totalAssets` no cuenta ganancias sin reportar; al reportarse se bloquean y se liberan linealmente durante `profitUnlockPeriod` (modelo similar a Yearn v3). `recall` y `emergencyRecallAll` reportan *antes* de mover fondos, así que no se puede cobrar la ganancia de golpe por esa vía.
- **Pérdidas reconocidas de inmediato.** `totalAssets` usa `min(valor actual, valor reconocido)` por estrategia; al reportarse, la pérdida baja `debt`, consume primero la ganancia bloqueada y dispara el circuit breaker si supera `maxDrawdownBps`. `allocate` rechaza estrategias que ya superaron el drawdown aunque nadie las haya reportado (`StrategyInDrawdown`).
- **Comisión pendiente en las vistas.** `_convertToShares`/`_convertToAssets` incluyen las shares de la comisión devengada, por lo que `previewRedeem/Withdraw/Deposit/Mint` coinciden con la ejecución (ERC-4626). `pendingFee()` expone el monto.
- **Checks-Effects-Interactions** en `allocate` (actualiza `debt` y emite evento antes de `safeTransfer`) y `ReentrancyGuard` en todas las funciones que mueven fondos.
- **`SafeERC20`** en todas las transferencias de tokens.
- **Custom errors** con parámetros (sin strings de error) y **eventos** para toda operación relevante.
- **Mitigación del ataque de inflación del primer depositante** con `_decimalsOffset() = 3` (shares virtuales de OpenZeppelin).
- **Lo recibido en un `recall` se mide por diferencia de balance**, sin confiar en el valor de retorno de la estrategia.
- **Empaquetado de storage:** `StrategyInfo` ocupa un único slot (`bool, bool, uint16, uint128`); `constant`/`immutable` donde corresponde; parámetros en `uint16`.
- **Sin** `tx.origin`, `delegatecall`, `selfdestruct` ni `assembly`. `unchecked` solo en contadores de bucle acotados por `MAX_STRATEGIES`.
- **`emergencyRecallAll`** usa `try/catch`: una estrategia rota no impide recuperar las demás.
- **Los retiros no dependen de `whenNotPaused`**: el usuario siempre puede sacar la liquidez disponible.
- `MockUSDC` y `MockTradingStrategy` son **solo para demostración**; no usar en producción.

---

## 11. Limitaciones conocidas del MVP

1. **Estrategia simulada:** `MockTradingStrategy` no opera en mercados reales; el PnL lo reporta una wallet con `BOT_ROLE`. En producción deben usarse adaptadores a protocolos reales (DEX, lending, perps) cuyo `totalAssets()` se calcule on-chain.
2. **Confianza en el valor de las estrategias:** `totalAssets()` del vault suma el de cada estrategia. Una estrategia mal diseñada que revierta en `totalAssets()` bloquearía operaciones del vault (riesgo acotado por whitelist de admin y `MAX_STRATEGIES = 10`). Mitigación planeada: ver roadmap.
3. **Retiros limitados a la liquidez ociosa:** si el capital está asignado, hay que esperar un `recall`. La reserva mínima mitiga pero no elimina esto.
4. **Admin centralizado:** el rol de admin debe ser un multisig/timelock en producción.
5. **Sin oráculos de precios:** el circuit breaker usa el valor reportado por la estrategia, no un precio externo.
6. **Sin auditoría profesional.** Proyecto académico.
7. El token de la demo (`MockUSDC`) tiene faucet público.
8. **Liberación gradual ≠ inmunidad total.** Quien deposita mucho capital y lo deja durante todo el período de liberación sí participa de la ganancia en proporción al tiempo que su capital estuvo expuesto. Un período largo (p. ej. 24 h en producción) encarece ese ataque; la demo usa 60 s solo para poder mostrarla en un video.
9. **Retiro antes de una pérdida:** quien observa en el mempool una pérdida inminente puede retirar antes. Mitigaciones previstas: cola de retiros / período mínimo de permanencia (roadmap).
10. **Estrategias reales** cuyo valor cambia sin una transacción propia dependen de un keeper que llame a `harvest` con frecuencia (Chainlink Automation en el roadmap). La estrategia de demo reporta sola tras cada operación.

---

## 12. Roadmap

**Fase 2 — Funcionalidad**
- Adaptadores reales: Uniswap v3 (LP), Aave v3 (lending), Aerodrome/GMX (perps), con `totalAssets()` calculado on-chain.
- Integración con **Chainlink** (precios / Automation) para disparar `checkStrategyHealth` y `harvest` automáticamente y valuar posiciones.
- Retiros asíncronos (cola ERC-7540) para estrategias con liquidez diferida.
- Múltiples vaults por activo y *fee on management* opcional.
- Fábrica de vaults (`VaultFactory`) con clones mínimos (EIP-1167) para bots de terceros.

**Fase 3 — Seguridad y escalabilidad**
- Admin detrás de **multisig + `TimelockController`**.
- Manejo robusto de estrategias que fallan: `try/catch` en `totalAssets()`, remoción forzada y valor cacheado.
- Fuzzing e *invariant testing* (Foundry/Echidna) y **auditoría externa**.
- Límites de *slippage* y de volumen por ventana temporal para el operador.
- Despliegue en L2 (Base/Arbitrum/Optimism) para reducir costos de gas del bot.
- Subgraph (The Graph) para analítica histórica (PnL, TVL, drawdown) en el frontend.

---

## Licencia

MIT — ver [LICENSE](LICENSE).
