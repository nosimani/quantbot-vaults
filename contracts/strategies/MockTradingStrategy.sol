// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IStrategy} from "../interfaces/IStrategy.sol";

/// @title MockTradingStrategy
/// @notice Estrategia de demostración que simula el resultado (PnL) de un bot de trading.
/// @dev Representa el "lado off-chain" del protocolo: un bot con `BOT_ROLE` reporta
///      ganancias (aportando fondos reales desde su wallet) o pérdidas (que se envían a
///      `LOSS_SINK`). Incluye un límite de pérdida por operación como control de riesgo.
///      En una versión productiva este contrato se reemplaza por adaptadores a DEXs/lending.
contract MockTradingStrategy is IStrategy, AccessControl {
    using SafeERC20 for IERC20;

    /// @notice Rol de la wallet del bot autorizado a reportar resultados de trading.
    bytes32 public constant BOT_ROLE = keccak256("BOT_ROLE");

    /// @notice Denominador de puntos básicos (10.000 = 100 %).
    uint256 public constant BPS = 10_000;

    /// @notice Dirección a la que se envían las pérdidas simuladas.
    address public constant LOSS_SINK = address(0xdead);

    /// @notice Pérdida máxima permitida por operación, en puntos básicos del balance actual.
    uint16 public immutable maxLossPerTradeBps;

    /// @dev Token subyacente.
    IERC20 private immutable _asset;

    /// @dev Bóveda propietaria de la estrategia.
    address private immutable _vault;

    /// @notice Se emite cada vez que el bot reporta el resultado de una operación.
    /// @param bot Wallet del bot que reportó.
    /// @param pnl Resultado de la operación (positivo = ganancia, negativo = pérdida).
    /// @param balanceAfter Balance de la estrategia luego de la operación.
    event TradeExecuted(address indexed bot, int256 pnl, uint256 balanceAfter);

    /// @notice Se emite cuando la bóveda retira fondos de la estrategia.
    /// @param amount Cantidad transferida a la bóveda.
    event Withdrawn(uint256 amount);

    /// @notice Una dirección requerida es la dirección cero.
    error ZeroAddress();

    /// @notice El valor en puntos básicos es inválido (cero o mayor a 100 %).
    /// @param bps Valor recibido.
    error InvalidBps(uint256 bps);

    /// @notice Solo la bóveda puede llamar a la función.
    /// @param caller Dirección que intentó la llamada.
    error NotVault(address caller);

    /// @notice El resultado reportado es cero.
    error ZeroPnl();

    /// @notice La pérdida reportada supera el límite por operación.
    /// @param loss Pérdida reportada.
    /// @param maxLoss Pérdida máxima permitida con el balance actual.
    error TradeLossTooLarge(uint256 loss, uint256 maxLoss);

    /// @dev Restringe la función a la bóveda propietaria.
    modifier onlyVault() {
        if (msg.sender != _vault) revert NotVault(msg.sender);
        _;
    }

    /// @notice Crea la estrategia.
    /// @param asset_ Token subyacente (el mismo de la bóveda).
    /// @param vault_ Bóveda propietaria.
    /// @param admin Administrador (otorga/revoca `BOT_ROLE`).
    /// @param maxLossPerTradeBps_ Pérdida máxima por operación en bps (1..10.000).
    constructor(IERC20 asset_, address vault_, address admin, uint16 maxLossPerTradeBps_) {
        if (address(asset_) == address(0) || vault_ == address(0) || admin == address(0)) {
            revert ZeroAddress();
        }
        if (maxLossPerTradeBps_ == 0 || maxLossPerTradeBps_ > BPS) {
            revert InvalidBps(maxLossPerTradeBps_);
        }
        _asset = asset_;
        _vault = vault_;
        maxLossPerTradeBps = maxLossPerTradeBps_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @inheritdoc IStrategy
    function asset() external view returns (address) {
        return address(_asset);
    }

    /// @inheritdoc IStrategy
    function vault() external view returns (address) {
        return _vault;
    }

    /// @inheritdoc IStrategy
    function totalAssets() external view returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    /// @notice El bot reporta el resultado de una operación de trading simulada.
    /// @dev Ganancia: el bot debe haber aprobado (`approve`) al menos `pnl` tokens a este contrato.
    ///      Pérdida: se envía a `LOSS_SINK`, limitada por `maxLossPerTradeBps`.
    /// @param pnl Resultado de la operación en unidades del activo (positivo ganancia, negativo pérdida).
    function executeTrade(int256 pnl) external onlyRole(BOT_ROLE) {
        if (pnl == 0) revert ZeroPnl();

        if (pnl > 0) {
            _asset.safeTransferFrom(msg.sender, address(this), uint256(pnl));
        } else {
            uint256 loss = uint256(-pnl);
            uint256 maxLoss = (_asset.balanceOf(address(this)) * maxLossPerTradeBps) / BPS;
            if (loss > maxLoss) revert TradeLossTooLarge(loss, maxLoss);
            _asset.safeTransfer(LOSS_SINK, loss);
        }

        emit TradeExecuted(msg.sender, pnl, _asset.balanceOf(address(this)));
    }

    /// @inheritdoc IStrategy
    function withdraw(uint256 amount) external onlyVault returns (uint256 withdrawn) {
        uint256 balance = _asset.balanceOf(address(this));
        withdrawn = amount > balance ? balance : amount;
        emit Withdrawn(withdrawn);
        _asset.safeTransfer(_vault, withdrawn);
    }
}
