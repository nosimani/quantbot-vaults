// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IStrategy
/// @notice Interfaz mínima que debe implementar cualquier estrategia (bot de trading)
///         conectable a una bóveda `QuantBotVault`.
/// @dev La bóveda transfiere los fondos a la estrategia con `transfer` y los recupera
///      llamando a `withdraw`. El valor de la estrategia se lee con `totalAssets`.
interface IStrategy {
    /// @notice Token subyacente con el que opera la estrategia.
    /// @return Dirección del token ERC20 (debe coincidir con el activo de la bóveda).
    function asset() external view returns (address);

    /// @notice Bóveda autorizada a retirar fondos de la estrategia.
    /// @return Dirección de la bóveda dueña de la estrategia.
    function vault() external view returns (address);

    /// @notice Valor total, expresado en el activo subyacente, que la estrategia administra.
    /// @return Cantidad de activo subyacente (incluye ganancias y pérdidas realizadas).
    function totalAssets() external view returns (uint256);

    /// @notice Devuelve fondos a la bóveda. Solo puede llamarla la bóveda.
    /// @param amount Cantidad solicitada de activo subyacente.
    /// @return withdrawn Cantidad efectivamente transferida a la bóveda (puede ser menor a `amount`).
    function withdraw(uint256 amount) external returns (uint256 withdrawn);
}
