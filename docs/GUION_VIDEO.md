# Guion del video de presentación y demo (máx. 5:00)

Objetivo: mostrar problema, arquitectura, flujo principal funcionando con evidencia on-chain, seguridad y roadmap.

| Tiempo | Qué mostrar | Qué decir |
|---|---|---|
| 0:00–0:30 | Slide/README: título del proyecto | "QuantBot Vaults: bóvedas automatizadas para que un bot de trading opere capital de terceros bajo reglas verificables on-chain." |
| 0:30–1:15 | Sección "Por qué blockchain" + diagrama de arquitectura del README | Problema de confianza con los bots; el operador no custodia fondos; whitelist, topes, reserva de liquidez, circuit breaker, pausa. ERC-4626 para composabilidad. |
| 1:15–2:15 | Código: `allocate` y `_accrueFee` en `QuantBotVault.sol` | Checks-Effects-Interactions, `SafeERC20`, custom errors, NatSpec, `ReentrancyGuard`, high-water mark, mitigación de inflación con `_decimalsOffset`. |
| 2:15–3:45 | **Demo en el frontend (Sepolia)**: conectar wallet → faucet → approve → depositar → asignar al bot → reportar ganancia → harvest → recall → retirar | Mostrar cómo cambian TVL, liquidez, shares y precio por share. Abrir en Etherscan al menos 2 transacciones. |
| 3:45–4:15 | Etherscan: contratos verificados + terminal con `npm test` y `npm run coverage` + salida de Slither | "3 contratos verificados, tests pasando, coverage > 40 %, Slither sin findings relevantes pendientes." |
| 4:15–4:45 | Intentar una acción bloqueada (ej. asignar con cuenta sin rol o superar el tope) | Mostrar el revert con custom error: el protocolo limita lo que el bot puede hacer. |
| 4:45–5:00 | README: Limitaciones y Roadmap | Estrategias reales (Uniswap/Aave), Chainlink Automation, timelock + multisig, auditoría. |

Consejos: grabar a 1080p, cursor visible, tener la wallet con ETH de Sepolia y los roles asignados **antes** de grabar, y ensayar una vez para no pasar de 5:00.
