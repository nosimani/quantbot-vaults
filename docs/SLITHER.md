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
## Actualización tras las correcciones del docente

El contrato cambió (liberación gradual de ganancias, reporte de estrategias, comisión pendiente en las vistas), así que **hay que volver a correr `npm run slither`** y actualizar la tabla de arriba con el resultado real. Hallazgos nuevos esperables y su clasificación:

| Detector | Dónde | Clasificación | Justificación |
|---|---|---|---|
| `timestamp` | `_remainingLockedProfit` | Aceptado | Usa `block.timestamp` solo para una liberación lineal con período mínimo de 60 s; un validador puede desviar el timestamp segundos, lo que cambia la liberación en una fracción mínima. |
| `calls-loop` | `totalAssets`, `harvest`, `emergencyRecallAll` | Aceptado | Bucles acotados por `MAX_STRATEGIES = 10` sobre estrategias registradas por el admin. |
| `reentrancy-*` | `recall`, `emergencyRecallAll` | Aceptado | Protegidas por `nonReentrant`; `debt` se concilia con lo realmente recibido. |
| `incorrect-equality` | comparaciones contra 0 | Falso positivo | Evitan trabajo inútil o divisiones por cero; no dependen de balances manipulables. |

## Segunda ejecución (contrato corregido, 13/11/2026)

Slither 29 contratos / 102 detectores: **55 resultados, 0 High**, 11 Medium, 34 Low, 10 Informational.

| Severidad | Detector | Cant. | Decisión |
|---|---|---|---|
| Medium | incorrect-equality | 6 | Justificado |
| Medium | unused-return | 3 | Justificado |
| Medium | reentrancy-no-eth | 2 | Justificado |
| Low | calls-loop | 24 | Justificado |
| Low | timestamp | 10 | Justificado |
| Informational | costly-loop | 7 | Aceptado |
| Informational | dead-code | 2 | Aceptado |
| Informational | missing-inheritance | 1 | Aceptado |

### Medium
- **incorrect-equality (6)**: son comparaciones `== 0` (por ejemplo en `_accrueFee`, en montos y en `totalSupply`). Solo sirven para evitar divisiones por cero u operaciones vacías. No dependen de un balance que un atacante pueda manipular con una donación para bloquear el contrato; en el peor caso se omite un cálculo.
- **unused-return (3)**: `IStrategy.withdraw` devuelve un monto, pero el vault no confía en ese valor. Mide lo recibido de verdad con la diferencia de `balanceOf` antes y después. En `MockTradingStrategy.executeTrade`, `checkStrategyHealth` es solo una notificación al vault y no necesita valor de retorno.
- **reentrancy-no-eth (2)** en `recall` y `emergencyRecallAll`: la llamada externa es a una estrategia aprobada por el admin (lista blanca, no a una dirección arbitraria). Ambas funciones usan `nonReentrant` y están restringidas por rol (`OPERATOR`/`GUARDIAN`). Se actualiza el estado después de `withdraw` a propósito, para contabilizar lo realmente recibido. Los tests de seguridad incluyen el caso de recall sin saltar el bloqueo de profit.

### Low
- **calls-loop (24)**: se recorren las estrategias del vault (lista corta y acotada por el admin) y se llama a contratos de confianza. No hay llamadas a direcciones arbitrarias del usuario.
- **timestamp (10)**: es intencional. El desbloqueo lineal del profit usa `block.timestamp`; el período mínimo es de 1 minuto, mucho mayor que el margen que puede mover un validador (segundos).

### Informational
- **costly-loop (7)**: escrituras de storage dentro de bucles sobre la lista acotada de estrategias.
- **dead-code (2)**: sobrescritura (`override`) de hooks de OpenZeppelin ERC-4626 que la base invoca internamente. Slither no resuelve esa llamada heredada.
- **missing-inheritance (1)**: `QuantBotVault` es llamado a través de `IVaultReporter` pero no declara la herencia. No tiene impacto de seguridad; se deja como mejora para una próxima versión para no redesplegar.

Conclusión: **sin hallazgos de severidad alta**; el resto está revisado y justificado.
