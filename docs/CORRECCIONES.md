# Correcciones tras la revisión del docente

| # | Observación del docente | Qué se hizo | Dónde |
|---|---|---|---|
| 1 | **Seguridad (obligatorio):** la ganancia de `executeTrade` entraba de golpe en `totalAssets`; quien depositaba justo antes y retiraba después se llevaba rendimiento ajeno. | Las ganancias se reconocen al reportarse, se **bloquean y se liberan linealmente** durante `profitUnlockPeriod`. `totalAssets` no cuenta ganancias sin reportar. `recall` y `emergencyRecallAll` reportan *antes* de mover fondos. La estrategia avisa al vault tras cada operación. | `QuantBotVault.sol` (`_reportStrategy`, `totalAssets`, `_remainingLockedProfit`), `MockTradingStrategy.sol` |
| 2 | `previewRedeem`/`previewWithdraw` no descontaban la comisión pendiente. | `_convertToShares`/`_convertToAssets` incluyen las shares de la comisión devengada. Nueva vista `pendingFee()`. Los previews coinciden con la ejecución. | `QuantBotVault.sol` (`_feeQuote`, `_totalsWithPendingFee`) |
| 3 | Tras una pérdida y un recall total quedaba `debt` residual y el circuit breaker volvía a dispararse. | Las pérdidas se dan de baja al reportarse (`debt` = valor real), consumen primero la ganancia bloqueada y disparan el circuit breaker automáticamente. `allocate` rechaza estrategias en drawdown (`StrategyInDrawdown`). | `QuantBotVault.sol` (`_reportStrategy`, `_absorbLoss`) |
| 4 | Sumar fuzzing / invariantes. | 6 semillas × 60 operaciones aleatorias con 7 invariantes (solvencia, reclamable ≤ total, conservación de tokens, precio por share, previews, "sin almuerzo gratis", cierre). | `test/QuantBotVault.fuzz.test.js` |
| 5 | Falta `frontend/.env.example`. | Agregado. | `frontend/.env.example` |
| 6 | Publicar el frontend. | Modo lectura sin wallet + workflow de GitHub Pages. | `.github/workflows/deploy-frontend.yml` |
| 7 | **Falta el video (obligatorio).** | Video subido al Drive de entrega y linkeado en el README (sección 8.4). | README |

## Límites que se documentan en el README
- Quien deja mucho capital durante todo el período de liberación sí participa de la ganancia en proporción al tiempo expuesto. En producción conviene un período largo (p. ej. 24 h).
- Retirar antes de una pérdida inminente (mempool) sigue siendo posible; mitigación prevista: cola de retiros o permanencia mínima.
