# Análisis estático con Slither

## Cómo ejecutarlo

```bash
pip install slither-analyzer
npm install
npm run slither
```

Alcance: `QuantBotVault.sol`, `MockTradingStrategy.sol`, `IStrategy.sol`. Se excluyen `node_modules` (OpenZeppelin) y `contracts/mocks` (token de prueba).

## Estado

> ⚠️ **Pendiente de ejecución real.** Esta tabla es un análisis previo, hecho leyendo el código, de los detectores que Slither suele reportar sobre este diseño. **Después de correr Slither, reemplazar la columna "Estado" con el resultado real** y agregar cualquier finding que aparezca y no esté acá. No entregar la tabla sin contrastarla con la salida real.

## Findings esperados y su clasificación

| Detector | Dónde | Clasificación | Justificación técnica |
|---|---|---|---|
| `calls-loop` | `totalAssets()`, `emergencyRecallAll()` | Aceptado | El bucle llama a estrategias whitelisteadas por el admin y acotadas por `MAX_STRATEGIES = 10`. Es inherente a la agregación de valor de múltiples estrategias. `emergencyRecallAll` usa `try/catch` para que una estrategia fallida no bloquee el resto. |
| `unused-return` | `recall()` → `IStrategy.withdraw` | Falso positivo / aceptado | El valor de retorno de la estrategia **no es confiable por diseño**: lo recibido se mide por diferencia de `balanceOf` en `_settleRecall`. |
| `reentrancy-events` / `reentrancy-benign` | `recall()`, `emergencyRecallAll()` | Aceptado | La llamada externa va a una estrategia whitelisteada y toda función que mueve fondos tiene `nonReentrant`. El evento posterior al llamado externo no permite explotación. |
| `reentrancy-no-eth` | `recall()` (escribe `debt` tras llamada externa) | Aceptado | Protegido por `nonReentrant`; la deuda se concilia con el balance realmente recibido, que solo se conoce después del retiro. |
| `timestamp` | — | No aplica | El vault no usa `block.timestamp` (solo `MockUSDC`, excluido). |
| `low-level-calls`, `assembly`, `delegatecall`, `tx-origin`, `suicidal` | — | No aplica | No se usan en código propio. |
| `naming-convention` (parámetros con `_` final, p. ej. `asset_`) | constructor, `owner_` | Falso positivo | Convención deliberada para evitar sombreado con funciones heredadas de ERC-4626 (`asset()`, `owner()`). |
| `solc-version` / `pragma` | OpenZeppelin | Fuera de alcance | Proviene de librerías externas. |
| Cualquier finding en `@openzeppelin/*` | — | Fuera de alcance | Librería de terceros auditada. |

## Registro de la ejecución real

Completar luego de correr Slither:

```
Fecha:
Versión de Slither:
Comando: npm run slither
Resumen (n.º de findings por severidad):
Findings corregidos (y commit):
Findings aceptados / falsos positivos (con justificación):
```
