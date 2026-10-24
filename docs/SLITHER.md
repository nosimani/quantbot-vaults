![# Análisis estático con Slither

## Cómo ejecutarlo

```bash
pip install slither-analyzer
npm install
npm run slither
```

Alcance: `QuantBotVault.sol`, `MockTradingStrategy.sol`, `IStrategy.sol`. Se excluyen `node_modules` (OpenZeppelin) y `contracts/mocks` (token de prueba).

## Resultado de la ejecución

Slither analizó 28 contratos con 102 detectores y reportó **33 resultados: 0 High, 8 Medium, 22 Low, 3 Informational**. Ningún finding requirió cambios en el código. Cada uno se clasifica abajo.

| Cantidad | Impacto | Detector | Clasificación |
|---|---|---|---|
| 4 | Medium | `incorrect-equality` | Falso positivo |
| 2 | Medium | `reentrancy-no-eth` | Aceptado |
| 2 | Medium | `unused-return` | Aceptado |
| 22 | Low | `calls-loop` | Aceptado |
| 2 | Informational | `dead-code` | Falso positivo |
| 1 | Informational | `costly-loop` | Aceptado |

## Justificación de cada finding

**`incorrect-equality` (4, Medium) — falso positivo.** Son comparaciones contra cero de valores calculados: `feeAssets == 0` y `feeShares == 0` en `_accrueFee`, `assets == 0` en `maxMint` y `supplyBefore == 0` en `_withdraw`. No comparan contra un balance que un atacante pueda manipular para forzar un estado: solo evitan trabajo inútil (mint de 0 shares) o una división por cero. Un valor manipulado no puede dañar fondos.

**`reentrancy-no-eth` (2, Medium) — aceptado.** `recall` y `emergencyRecallAll` llaman a `IStrategy.withdraw` y luego actualizan `strategyInfo[strategy].debt` en `_settleRecall`. El orden es intencional: `debt` se concilia con lo realmente recibido, que solo se conoce después del retiro. Ambas funciones tienen `nonReentrant`, la estrategia es una dirección whitelisteada por el admin y verificada al registrarla (`asset()` y `vault()`), y no hay reentrada posible hacia otras funciones que muevan fondos.

**`unused-return` (2, Medium) — aceptado.** `recall` y `emergencyRecallAll` ignoran el valor que devuelve `IStrategy.withdraw` a propósito: lo recibido se mide por diferencia de `balanceOf` del vault en `_settleRecall`, para no confiar en lo que reporta un contrato externo.

**`calls-loop` (22, Low) — aceptado.** Las ocurrencias provienen solo de `totalAssets`, `emergencyRecallAll` y `_settleRecall`. Todas están en bucles sobre `_strategies`, acotada por `MAX_STRATEGIES = 10` y limitada a estrategias registradas por el admin. Es inherente a agregar el valor de varias estrategias. `emergencyRecallAll` usa `try/catch` para que una estrategia fallida no bloquee el resto.

**`dead-code` (2, Informational) — falso positivo.** `_deposit` y `_withdraw` son overrides de funciones internas de ERC-4626 de OpenZeppelin. Las invocan `deposit`, `mint`, `withdraw` y `redeem` heredadas, por lo que Slither no detecta su uso.

**`costly-loop` (1, Informational) — aceptado.** `_strategies.pop()` dentro del bucle de `removeStrategy`, que hace `break` justo después y está acotado por `MAX_STRATEGIES`. Se ejecuta una sola vez por llamada.

## Registro

```
Comando: npm run slither
Entorno: GitHub Codespaces
Fecha: 2026-10-24
Resultado: 33 findings (0 High, 8 Medium, 22 Low, 3 Informational)
Corregidos: ninguno requirió cambios en el código
Aceptados / falsos positivos: justificados arriba
Fuera de alcance: OpenZeppelin y contracts/mocks (excluidos en slither.config.json)
```