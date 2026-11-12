// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IVaultReporter
/// @notice Interfaz mínima de la bóveda que usa una estrategia para avisar que su valor cambió.
interface IVaultReporter {
    /// @notice Reconoce en la bóveda la ganancia o pérdida de `strategy` y aplica el circuit breaker.
    /// @param strategy Estrategia que se reporta (debe estar registrada en la bóveda).
    /// @return healthy `false` si el circuit breaker desactivó la estrategia en esta llamada.
    function checkStrategyHealth(address strategy) external returns (bool healthy);
}
