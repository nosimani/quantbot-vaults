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
| Fee de performance con *high-water mark* | Cobrar comisión dos veces sobre la misma ganancia o cobrar sobre depósitos nuevos. Se paga acuñando shares al treasury. |
| Tope de depósitos (`depositCap`) | Exposición excesiva durante la fase MVP. |

**Flujo principal (el que se muestra en la demo):**

```
usuario ──deposit──▶ Vault ──allocate (bot)──▶ Strategy
                        ▲                          │ executeTrade(+pnl)  (el bot reporta ganancia)
                        └────── recall ◀───────────┘
usuario ◀─redeem (capital + ganancia − fee)─ Vault          harvest ─▶ mint de shares de fee al treasury
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

Cobertura de escenarios (3 archivos):

- **Éxito del flujo principal:** depósito → allocate → ganancia del bot → harvest (fee) → recall → redeem con rendimiento.
- **Reverts / errores:** permisos (`AccessControlUnauthorizedAccount`), allocate a dirección no registrada, monto cero, liquidez insuficiente, tope por estrategia, reserva mínima, parámetros inválidos del constructor, tope de depósitos, pausa, estrategia incompatible, `MAX_STRATEGIES`, pérdida por encima del límite.
- **Riesgo:** circuit breaker por drawdown, high-water mark (sin doble cobro), depósito nuevo no se cobra como ganancia, pausa que no bloquea retiros, `emergencyRecallAll`.
- **Invariante:** lo reclamable por todos los holders nunca excede `totalAssets` en una secuencia determinística de operaciones.

> Resultado de coverage: ver `docs/EVIDENCIA.md` (completar con la salida real de `npm run coverage`; el requisito es superar el 40 % en todas las métricas).

---

## 7. Análisis estático con Slither

```bash
pip install slither-analyzer      # una sola vez
npm run slither                   # = slither . --config-file slither.config.json
```

La configuración (`slither.config.json`) excluye `node_modules` y `contracts/mocks`. El análisis previo y la justificación de los findings esperados está en [`docs/SLITHER.md`](docs/SLITHER.md).

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
```

`deploy` escribe `deployments/sepolia.json` (direcciones y argumentos de constructor) y `demo` escribe `deployments/sepolia-demo.json` con los hashes y links de cada transacción. **Copiar esos datos a la sección 9 de este README.**

### 8.3 Frontend

```bash
cd frontend
npm install
cp .env.example .env     # pegar las direcciones de deployments/sepolia.json
npm run dev              # http://localhost:5173
```

Desde la UI: conectar wallet → *faucet* → aprobar → depositar → (cuenta con roles de operador/bot) asignar al bot, reportar ganancia/pérdida, harvest, chequear drawdown → retirar. Los botones de operador/bot/guardián se habilitan solo si la cuenta tiene el rol on-chain. Cada transacción muestra un link al explorer.

---

## 9. Red y contratos desplegados

> ⚠️ **Completar después de ejecutar el deploy.** No inventar valores: copiar de `deployments/sepolia.json` y `deployments/sepolia-demo.json`.

**Red:** Sepolia (chainId 11155111)

| Contrato | Dirección | Código verificado |
|---|---|---|
| MockUSDC | `0x…` | `https://sepolia.etherscan.io/address/0x…#code` |
| QuantBotVault | `0x…` | `https://sepolia.etherscan.io/address/0x…#code` |
| MockTradingStrategy | `0x…` | `https://sepolia.etherscan.io/address/0x…#code` |

**Transacciones reales del flujo principal** (salida de `npm run demo:sepolia`):

| Paso | Hash / link |
|---|---|
| 1. Faucet mUSDC | `0x…` |
| 2. Approve | `0x…` |
| 3. Depósito de 1000 mUSDC | `0x…` |
| 4. Bot asigna capital | `0x…` |
| 6. Bot reporta ganancia | `0x…` |
| 7. Harvest (fee) | `0x…` |
| 8. Health check | `0x…` |
| 9. Recall | `0x…` |
| 10. Redeem | `0x…` |

---

## 10. Seguridad: decisiones de diseño

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
