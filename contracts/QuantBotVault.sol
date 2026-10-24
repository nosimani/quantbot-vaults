// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IStrategy} from "./interfaces/IStrategy.sol";

/// @title QuantBotVault
/// @author QuantBot Vaults team
/// @notice Bóveda ERC-4626 que recibe depósitos de usuarios y permite a un operador
///         (bot de trading) asignar capital a estrategias whitelisteadas, bajo límites de
///         riesgo aplicados on-chain: tope por estrategia, reserva mínima de liquidez,
///         circuit breaker por drawdown, pausa de emergencia y comisión de performance
///         con high-water mark.
/// @dev Roles:
///      - `DEFAULT_ADMIN_ROLE`: registra/remueve estrategias, ajusta parámetros, reanuda el vault.
///      - `OPERATOR_ROLE`: wallet del bot; asigna (`allocate`) y recupera (`recall`) capital.
///      - `GUARDIAN_ROLE`: puede pausar, desactivar estrategias y ejecutar `emergencyRecallAll`.
///      Los usuarios NUNCA pierden la posibilidad de retirar liquidez disponible, ni siquiera en pausa.
///      El bot no puede transferir fondos a direcciones arbitrarias: solo a estrategias registradas.
contract QuantBotVault is ERC4626, AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    // ---------------------------------------------------------------------
    // Tipos
    // ---------------------------------------------------------------------

    /// @notice Datos de una estrategia registrada (empaquetados en un único slot).
    /// @param registered Indica si la estrategia existe en el vault.
    /// @param active Indica si admite nuevas asignaciones de capital.
    /// @param maxAllocationBps Máximo porcentaje del vault (en bps) que puede tener la estrategia.
    /// @param debt Capital neto asignado a la estrategia (principal pendiente de devolver).
    struct StrategyInfo {
        bool registered;
        bool active;
        uint16 maxAllocationBps;
        uint128 debt;
    }

    // ---------------------------------------------------------------------
    // Constantes
    // ---------------------------------------------------------------------

    /// @notice Rol del bot operador (asigna y recupera capital).
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Rol del guardián (pausa y recupera capital en emergencias).
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Denominador de puntos básicos (10.000 = 100 %).
    uint256 public constant BPS = 10_000;

    /// @notice Comisión de performance máxima configurable (30 %).
    uint256 public constant MAX_PERFORMANCE_FEE_BPS = 3_000;

    /// @notice Cantidad máxima de estrategias simultáneas (acota el gas de `totalAssets`).
    uint256 public constant MAX_STRATEGIES = 10;

    // ---------------------------------------------------------------------
    // Estado
    // ---------------------------------------------------------------------

    /// @notice Información de cada estrategia registrada.
    mapping(address strategy => StrategyInfo info) public strategyInfo;

    /// @dev Lista de estrategias registradas (acotada por `MAX_STRATEGIES`).
    address[] private _strategies;

    /// @notice Destinatario de las comisiones de performance (recibe shares).
    address public treasury;

    /// @notice Comisión de performance en bps, cobrada sobre ganancias nuevas.
    uint16 public performanceFeeBps;

    /// @notice Porcentaje mínimo (bps) del vault que debe permanecer líquido en el vault.
    uint16 public minIdleBps;

    /// @notice Pérdida máxima tolerada (bps) por estrategia antes de desactivarla.
    uint16 public maxDrawdownBps;

    /// @notice Tope máximo de activos totales administrados por el vault.
    uint256 public depositCap;

    /// @notice High-water mark en activos: base sobre la cual se calcula la próxima comisión.
    uint256 public lastTotalAssets;

    // ---------------------------------------------------------------------
    // Eventos
    // ---------------------------------------------------------------------

    /// @notice Se registró una estrategia.
    /// @param strategy Dirección de la estrategia.
    /// @param maxAllocationBps Tope de asignación en bps.
    event StrategyAdded(address indexed strategy, uint16 maxAllocationBps);

    /// @notice Se removió una estrategia (debía estar vacía).
    /// @param strategy Dirección de la estrategia.
    event StrategyRemoved(address indexed strategy);

    /// @notice Se modificó el tope de asignación de una estrategia.
    /// @param strategy Dirección de la estrategia.
    /// @param maxAllocationBps Nuevo tope en bps.
    event StrategyCapUpdated(address indexed strategy, uint16 maxAllocationBps);

    /// @notice Se activó una estrategia.
    /// @param strategy Dirección de la estrategia.
    event StrategyActivated(address indexed strategy);

    /// @notice Se desactivó una estrategia (manual por guardián).
    /// @param strategy Dirección de la estrategia.
    event StrategyDeactivated(address indexed strategy);

    /// @notice El circuit breaker desactivó una estrategia por superar el drawdown máximo.
    /// @param strategy Dirección de la estrategia.
    /// @param debt Capital neto asignado.
    /// @param currentAssets Valor actual de la estrategia.
    event StrategyTripped(address indexed strategy, uint256 debt, uint256 currentAssets);

    /// @notice Se asignó capital a una estrategia.
    /// @param strategy Estrategia receptora.
    /// @param amount Cantidad asignada.
    event Allocated(address indexed strategy, uint256 amount);

    /// @notice Se recuperó capital desde una estrategia.
    /// @param strategy Estrategia de origen.
    /// @param requested Cantidad solicitada.
    /// @param received Cantidad efectivamente recibida por el vault.
    event Recalled(address indexed strategy, uint256 requested, uint256 received);

    /// @notice Falló el retiro de una estrategia durante una recuperación de emergencia.
    /// @param strategy Estrategia que falló.
    event RecallFailed(address indexed strategy);

    /// @notice El guardián ejecutó una recuperación de emergencia (pausa + recall de todas).
    /// @param guardian Dirección del guardián.
    event EmergencyRecall(address indexed guardian);

    /// @notice Se cobró comisión de performance acuñando shares al treasury.
    /// @param recipient Destinatario de las shares.
    /// @param profit Ganancia nueva sobre el high-water mark.
    /// @param feeAssets Valor de la comisión en activos.
    /// @param feeShares Shares acuñadas al treasury.
    event FeeAccrued(address indexed recipient, uint256 profit, uint256 feeAssets, uint256 feeShares);

    /// @notice Cambió la comisión de performance.
    /// @param feeBps Nueva comisión en bps.
    event PerformanceFeeUpdated(uint16 feeBps);

    /// @notice Cambió el treasury.
    /// @param newTreasury Nueva dirección.
    event TreasuryUpdated(address indexed newTreasury);

    /// @notice Cambió el tope de depósitos.
    /// @param newDepositCap Nuevo tope de activos totales.
    event DepositCapUpdated(uint256 newDepositCap);

    /// @notice Cambió la reserva mínima de liquidez.
    /// @param newMinIdleBps Nuevo valor en bps.
    event MinIdleBpsUpdated(uint16 newMinIdleBps);

    /// @notice Cambió el drawdown máximo tolerado.
    /// @param newMaxDrawdownBps Nuevo valor en bps.
    event MaxDrawdownBpsUpdated(uint16 newMaxDrawdownBps);

    // ---------------------------------------------------------------------
    // Errores
    // ---------------------------------------------------------------------

    /// @notice Una dirección requerida es la dirección cero.
    error ZeroAddress();

    /// @notice La cantidad debe ser mayor a cero.
    error ZeroAmount();

    /// @notice Un valor en puntos básicos excede 10.000.
    /// @param value Valor recibido.
    error InvalidBps(uint256 value);

    /// @notice La comisión supera el máximo permitido.
    /// @param fee Comisión solicitada en bps.
    /// @param max Máximo permitido en bps.
    error FeeTooHigh(uint256 fee, uint256 max);

    /// @notice La estrategia ya está registrada.
    /// @param strategy Dirección de la estrategia.
    error StrategyAlreadyRegistered(address strategy);

    /// @notice La estrategia no está registrada.
    /// @param strategy Dirección de la estrategia.
    error StrategyNotRegistered(address strategy);

    /// @notice La estrategia está desactivada y no admite asignaciones.
    /// @param strategy Dirección de la estrategia.
    error StrategyNotActive(address strategy);

    /// @notice La estrategia no coincide con el activo o la bóveda de este vault.
    /// @param strategy Dirección de la estrategia.
    error StrategyMismatch(address strategy);

    /// @notice La estrategia aún tiene fondos y no puede removerse.
    /// @param strategy Dirección de la estrategia.
    /// @param assets Activos que todavía administra.
    error StrategyNotEmpty(address strategy, uint256 assets);

    /// @notice Se alcanzó la cantidad máxima de estrategias.
    /// @param max Máximo permitido.
    error TooManyStrategies(uint256 max);

    /// @notice No hay liquidez suficiente en el vault para la asignación.
    /// @param requested Cantidad solicitada.
    /// @param idle Liquidez disponible.
    error InsufficientIdle(uint256 requested, uint256 idle);

    /// @notice La asignación dejaría al vault por debajo de la reserva mínima.
    /// @param idleAfter Liquidez que quedaría luego de la asignación.
    /// @param required Liquidez mínima exigida.
    error MinIdleReserveBreached(uint256 idleAfter, uint256 required);

    /// @notice La asignación excede el tope de la estrategia.
    /// @param wouldBe Monto que tendría la estrategia luego de la asignación.
    /// @param max Máximo permitido para la estrategia.
    error AllocationCapExceeded(uint256 wouldBe, uint256 max);

    /// @notice El llamador no es operador ni guardián.
    /// @param caller Dirección que intentó la llamada.
    error NotOperatorOrGuardian(address caller);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @notice Despliega el vault.
    /// @dev No otorga `OPERATOR_ROLE` ni `GUARDIAN_ROLE`: el admin debe hacerlo explícitamente.
    /// @param asset_ Token ERC20 subyacente.
    /// @param name_ Nombre del token de shares.
    /// @param symbol_ Símbolo del token de shares.
    /// @param admin Administrador inicial (recomendado: multisig).
    /// @param treasury_ Destinatario de comisiones.
    /// @param performanceFeeBps_ Comisión de performance en bps (<= `MAX_PERFORMANCE_FEE_BPS`).
    /// @param depositCap_ Tope de activos totales del vault.
    /// @param minIdleBps_ Reserva mínima de liquidez en bps (<= 10.000).
    /// @param maxDrawdownBps_ Drawdown máximo por estrategia en bps (<= 10.000).
    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address admin,
        address treasury_,
        uint16 performanceFeeBps_,
        uint256 depositCap_,
        uint16 minIdleBps_,
        uint16 maxDrawdownBps_
    ) ERC4626(asset_) ERC20(name_, symbol_) {
        if (admin == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (performanceFeeBps_ > MAX_PERFORMANCE_FEE_BPS) {
            revert FeeTooHigh(performanceFeeBps_, MAX_PERFORMANCE_FEE_BPS);
        }
        if (minIdleBps_ > BPS) revert InvalidBps(minIdleBps_);
        if (maxDrawdownBps_ > BPS) revert InvalidBps(maxDrawdownBps_);

        treasury = treasury_;
        performanceFeeBps = performanceFeeBps_;
        depositCap = depositCap_;
        minIdleBps = minIdleBps_;
        maxDrawdownBps = maxDrawdownBps_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Vistas
    // ---------------------------------------------------------------------

    /// @notice Activos totales del vault: liquidez propia + valor de todas las estrategias.
    /// @return total Suma de activos administrados, en unidades del token subyacente.
    function totalAssets() public view override returns (uint256 total) {
        total = IERC20(asset()).balanceOf(address(this));
        uint256 len = _strategies.length;
        for (uint256 i; i < len; ) {
            total += IStrategy(_strategies[i]).totalAssets();
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Liquidez disponible dentro del vault (no asignada a estrategias).
    /// @return Cantidad de activo subyacente inmediatamente retirable.
    function idleAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this));
    }

    /// @notice Lista de estrategias registradas.
    /// @return Arreglo con las direcciones de las estrategias.
    function getStrategies() external view returns (address[] memory) {
        return _strategies;
    }

    /// @notice Cantidad de estrategias registradas.
    /// @return Longitud de la lista de estrategias.
    function strategiesLength() external view returns (uint256) {
        return _strategies.length;
    }

    /// @notice Máximo depositable en activos (0 si el vault está pausado o lleno).
    /// @return Cantidad máxima de activos que acepta `deposit`.
    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        uint256 total = totalAssets();
        return total >= depositCap ? 0 : depositCap - total;
    }

    /// @notice Máximo acuñable en shares (0 si el vault está pausado o lleno).
    /// @param receiver Receptor de las shares.
    /// @return Cantidad máxima de shares que acepta `mint`.
    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        return assets == 0 ? 0 : convertToShares(assets);
    }

    /// @notice Máximo retirable por `owner_` en activos, limitado por la liquidez del vault.
    /// @param owner_ Dueño de las shares.
    /// @return Cantidad máxima de activos que puede retirar hoy.
    function maxWithdraw(address owner_) public view override returns (uint256) {
        uint256 byShares = super.maxWithdraw(owner_);
        uint256 idle = idleAssets();
        return byShares < idle ? byShares : idle;
    }

    /// @notice Máximo canjeable por `owner_` en shares, limitado por la liquidez del vault.
    /// @param owner_ Dueño de las shares.
    /// @return Cantidad máxima de shares que puede canjear hoy.
    function maxRedeem(address owner_) public view override returns (uint256) {
        uint256 byBalance = balanceOf(owner_);
        uint256 byIdle = convertToShares(idleAssets());
        return byBalance < byIdle ? byBalance : byIdle;
    }

    // ---------------------------------------------------------------------
    // Operaciones de usuarios (ERC-4626) — cobran comisión pendiente antes de operar
    // ---------------------------------------------------------------------

    /// @notice Deposita `assets` y acuña shares a `receiver`.
    /// @param assets Cantidad de activos a depositar.
    /// @param receiver Receptor de las shares.
    /// @return shares Shares acuñadas.
    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256 shares) {
        _accrueFee();
        return super.deposit(assets, receiver);
    }

    /// @notice Acuña exactamente `shares` a `receiver` cobrando los activos necesarios.
    /// @param shares Shares a acuñar.
    /// @param receiver Receptor de las shares.
    /// @return assets Activos cobrados al llamador.
    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256 assets) {
        _accrueFee();
        return super.mint(shares, receiver);
    }

    /// @notice Retira exactamente `assets` quemando las shares necesarias de `owner_`.
    /// @param assets Activos a retirar.
    /// @param receiver Receptor de los activos.
    /// @param owner_ Dueño de las shares a quemar.
    /// @return shares Shares quemadas.
    function withdraw(uint256 assets, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        _accrueFee();
        return super.withdraw(assets, receiver, owner_);
    }

    /// @notice Canjea `shares` de `owner_` por activos.
    /// @param shares Shares a quemar.
    /// @param receiver Receptor de los activos.
    /// @param owner_ Dueño de las shares.
    /// @return assets Activos entregados.
    function redeem(uint256 shares, address receiver, address owner_)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        _accrueFee();
        return super.redeem(shares, receiver, owner_);
    }

    // ---------------------------------------------------------------------
    // Operaciones del bot (OPERATOR_ROLE)
    // ---------------------------------------------------------------------

    /// @notice Asigna capital líquido del vault a una estrategia activa.
    /// @dev Aplica: estrategia activa, liquidez suficiente, reserva mínima y tope por estrategia.
    ///      Sigue Checks-Effects-Interactions: actualiza `debt` antes de transferir.
    /// @param strategy Estrategia receptora.
    /// @param amount Cantidad de activos a asignar.
    function allocate(address strategy, uint256 amount)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        StrategyInfo memory info = strategyInfo[strategy];
        if (!info.registered) revert StrategyNotRegistered(strategy);
        if (!info.active) revert StrategyNotActive(strategy);
        if (amount == 0) revert ZeroAmount();

        IERC20 token = IERC20(asset());
        uint256 idle = token.balanceOf(address(this));
        if (amount > idle) revert InsufficientIdle(amount, idle);

        uint256 total = totalAssets();
        uint256 idleAfter = idle - amount;
        uint256 requiredIdle = (total * minIdleBps) / BPS;
        if (idleAfter < requiredIdle) revert MinIdleReserveBreached(idleAfter, requiredIdle);

        uint256 wouldBe = IStrategy(strategy).totalAssets() + amount;
        uint256 maxAllowed = (total * info.maxAllocationBps) / BPS;
        if (wouldBe > maxAllowed) revert AllocationCapExceeded(wouldBe, maxAllowed);

        // Effects
        strategyInfo[strategy].debt = SafeCast.toUint128(uint256(info.debt) + amount);
        emit Allocated(strategy, amount);

        // Interactions
        token.safeTransfer(strategy, amount);
    }

    /// @notice Recupera capital de una estrategia hacia el vault (operador o guardián).
    /// @param strategy Estrategia de origen.
    /// @param amount Cantidad solicitada (la estrategia puede devolver menos).
    function recall(address strategy, uint256 amount) external nonReentrant {
        if (!hasRole(OPERATOR_ROLE, msg.sender) && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert NotOperatorOrGuardian(msg.sender);
        }
        if (!strategyInfo[strategy].registered) revert StrategyNotRegistered(strategy);
        if (amount == 0) revert ZeroAmount();

        uint256 balanceBefore = IERC20(asset()).balanceOf(address(this));
        IStrategy(strategy).withdraw(amount);
        _settleRecall(strategy, amount, balanceBefore);
    }

    // ---------------------------------------------------------------------
    // Gestión de riesgo
    // ---------------------------------------------------------------------

    /// @notice Circuit breaker: desactiva la estrategia si perdió más que `maxDrawdownBps`.
    /// @dev Puede llamarla cualquiera (función permisionless, solo puede reducir riesgo).
    /// @param strategy Estrategia a evaluar.
    /// @return healthy `true` si la estrategia sigue dentro del límite de drawdown.
    function checkStrategyHealth(address strategy) external returns (bool healthy) {
        StrategyInfo memory info = strategyInfo[strategy];
        if (!info.registered) revert StrategyNotRegistered(strategy);
        if (!info.active || info.debt == 0) return true;

        uint256 current = IStrategy(strategy).totalAssets();
        uint256 floor = (uint256(info.debt) * (BPS - maxDrawdownBps)) / BPS;
        if (current >= floor) return true;

        strategyInfo[strategy].active = false;
        emit StrategyTripped(strategy, info.debt, current);
        return false;
    }

    /// @notice Pausa depósitos y nuevas asignaciones. Los retiros siguen habilitados.
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @notice Reanuda el vault. Solo el administrador.
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Desactiva una estrategia para que no reciba más capital.
    /// @param strategy Estrategia a desactivar.
    function deactivateStrategy(address strategy) external onlyRole(GUARDIAN_ROLE) {
        if (!strategyInfo[strategy].registered) revert StrategyNotRegistered(strategy);
        strategyInfo[strategy].active = false;
        emit StrategyDeactivated(strategy);
    }

    /// @notice Pausa el vault y recupera todo el capital posible de todas las estrategias.
    /// @dev Si una estrategia falla al retirar, se emite `RecallFailed` y se continúa con las demás.
    function emergencyRecallAll() external onlyRole(GUARDIAN_ROLE) nonReentrant {
        if (!paused()) _pause();

        IERC20 token = IERC20(asset());
        uint256 len = _strategies.length;
        for (uint256 i; i < len; ) {
            address strategy = _strategies[i];
            uint256 amount = IStrategy(strategy).totalAssets();
            if (amount > 0) {
                uint256 balanceBefore = token.balanceOf(address(this));
                try IStrategy(strategy).withdraw(amount) {
                    _settleRecall(strategy, amount, balanceBefore);
                } catch {
                    emit RecallFailed(strategy);
                }
            }
            unchecked {
                ++i;
            }
        }
        emit EmergencyRecall(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Administración (DEFAULT_ADMIN_ROLE)
    // ---------------------------------------------------------------------

    /// @notice Registra una nueva estrategia (queda activa).
    /// @param strategy Dirección de la estrategia; debe usar el mismo activo y apuntar a este vault.
    /// @param maxAllocationBps Tope de asignación en bps (1..10.000).
    function addStrategy(address strategy, uint16 maxAllocationBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (strategy == address(0)) revert ZeroAddress();
        if (strategyInfo[strategy].registered) revert StrategyAlreadyRegistered(strategy);
        if (_strategies.length >= MAX_STRATEGIES) revert TooManyStrategies(MAX_STRATEGIES);
        if (maxAllocationBps == 0 || maxAllocationBps > BPS) revert InvalidBps(maxAllocationBps);
        if (IStrategy(strategy).asset() != asset() || IStrategy(strategy).vault() != address(this)) {
            revert StrategyMismatch(strategy);
        }

        strategyInfo[strategy] =
            StrategyInfo({registered: true, active: true, maxAllocationBps: maxAllocationBps, debt: 0});
        _strategies.push(strategy);
        emit StrategyAdded(strategy, maxAllocationBps);
    }

    /// @notice Remueve una estrategia sin fondos.
    /// @param strategy Estrategia a remover.
    function removeStrategy(address strategy) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!strategyInfo[strategy].registered) revert StrategyNotRegistered(strategy);
        uint256 assets = IStrategy(strategy).totalAssets();
        if (assets != 0) revert StrategyNotEmpty(strategy, assets);

        uint256 len = _strategies.length;
        for (uint256 i; i < len; ) {
            if (_strategies[i] == strategy) {
                _strategies[i] = _strategies[len - 1];
                _strategies.pop();
                break;
            }
            unchecked {
                ++i;
            }
        }
        delete strategyInfo[strategy];
        emit StrategyRemoved(strategy);
    }

    /// @notice Modifica el tope de asignación de una estrategia.
    /// @param strategy Estrategia a modificar.
    /// @param maxAllocationBps Nuevo tope en bps (1..10.000).
    function setStrategyCap(address strategy, uint16 maxAllocationBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!strategyInfo[strategy].registered) revert StrategyNotRegistered(strategy);
        if (maxAllocationBps == 0 || maxAllocationBps > BPS) revert InvalidBps(maxAllocationBps);
        strategyInfo[strategy].maxAllocationBps = maxAllocationBps;
        emit StrategyCapUpdated(strategy, maxAllocationBps);
    }

    /// @notice Reactiva una estrategia desactivada.
    /// @param strategy Estrategia a reactivar.
    function activateStrategy(address strategy) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!strategyInfo[strategy].registered) revert StrategyNotRegistered(strategy);
        strategyInfo[strategy].active = true;
        emit StrategyActivated(strategy);
    }

    /// @notice Cambia la comisión de performance (cobra antes la pendiente con la tasa vieja).
    /// @param feeBps Nueva comisión en bps (<= `MAX_PERFORMANCE_FEE_BPS`).
    function setPerformanceFeeBps(uint16 feeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeBps > MAX_PERFORMANCE_FEE_BPS) revert FeeTooHigh(feeBps, MAX_PERFORMANCE_FEE_BPS);
        _accrueFee();
        performanceFeeBps = feeBps;
        emit PerformanceFeeUpdated(feeBps);
    }

    /// @notice Cambia el treasury (cobra antes la comisión pendiente al treasury anterior).
    /// @param newTreasury Nueva dirección receptora.
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        _accrueFee();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    /// @notice Cambia el tope de activos totales del vault.
    /// @param newCap Nuevo tope.
    function setDepositCap(uint256 newCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositCap = newCap;
        emit DepositCapUpdated(newCap);
    }

    /// @notice Cambia la reserva mínima de liquidez.
    /// @param newMinIdleBps Nuevo valor en bps (<= 10.000).
    function setMinIdleBps(uint16 newMinIdleBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMinIdleBps > BPS) revert InvalidBps(newMinIdleBps);
        minIdleBps = newMinIdleBps;
        emit MinIdleBpsUpdated(newMinIdleBps);
    }

    /// @notice Cambia el drawdown máximo tolerado por estrategia.
    /// @param newMaxDrawdownBps Nuevo valor en bps (<= 10.000).
    function setMaxDrawdownBps(uint16 newMaxDrawdownBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMaxDrawdownBps > BPS) revert InvalidBps(newMaxDrawdownBps);
        maxDrawdownBps = newMaxDrawdownBps;
        emit MaxDrawdownBpsUpdated(newMaxDrawdownBps);
    }

    /// @notice Cobra la comisión de performance pendiente. Cualquiera puede llamarla.
    function harvest() external nonReentrant {
        _accrueFee();
    }

    // ---------------------------------------------------------------------
    // Internas
    // ---------------------------------------------------------------------

    /// @dev Cantidad de decimales extra de las shares: mitiga el ataque de inflación del primer depositante.
    /// @return Offset de decimales (3).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    /// @dev Cobra la comisión sobre las ganancias nuevas por encima del high-water mark,
    ///      acuñando shares al treasury. Si hay pérdidas no modifica el high-water mark,
    ///      de modo que las recuperaciones no se comisionan dos veces.
    function _accrueFee() internal {
        uint256 total = totalAssets();
        uint256 last = lastTotalAssets;
        if (total <= last) return;

        uint256 profit = total - last;
        uint256 feeAssets = (profit * performanceFeeBps) / BPS;
        lastTotalAssets = total;
        if (feeAssets == 0) return;

        // Shares que valen `feeAssets` al precio posterior a la acuñación.
        uint256 feeShares = feeAssets.mulDiv(totalSupply() + 10 ** _decimalsOffset(), total - feeAssets + 1);
        if (feeShares == 0) return;

        address to = treasury;
        emit FeeAccrued(to, profit, feeAssets, feeShares);
        _mint(to, feeShares);
    }

    /// @dev Reconcilia `debt` y emite `Recalled` tras un retiro de estrategia.
    ///      Mide lo recibido por diferencia de balance (no confía en el valor de retorno).
    /// @param strategy Estrategia de origen.
    /// @param requested Cantidad solicitada.
    /// @param balanceBefore Balance líquido del vault antes del retiro.
    function _settleRecall(address strategy, uint256 requested, uint256 balanceBefore) private {
        uint256 received = IERC20(asset()).balanceOf(address(this)) - balanceBefore;
        uint256 debt = strategyInfo[strategy].debt;
        // received < debt <= type(uint128).max en la rama else, por lo que el cast es seguro.
        strategyInfo[strategy].debt = received >= debt ? 0 : uint128(debt - received);
        emit Recalled(strategy, requested, received);
    }

    /// @dev Tras un depósito suma lo depositado al high-water mark (el capital nuevo no es ganancia).
    /// @param caller Quien aporta los activos.
    /// @param receiver Receptor de shares.
    /// @param assets Activos depositados.
    /// @param shares Shares acuñadas.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        lastTotalAssets += assets;
    }

    /// @dev Tras un retiro reduce el high-water mark proporcionalmente a las shares quemadas.
    /// @param caller Quien ejecuta el retiro.
    /// @param receiver Receptor de activos.
    /// @param owner_ Dueño de las shares.
    /// @param assets Activos retirados.
    /// @param shares Shares quemadas.
    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
    {
        uint256 supplyBefore = totalSupply();
        super._withdraw(caller, receiver, owner_, assets, shares);
        lastTotalAssets = supplyBefore == 0 ? 0 : lastTotalAssets.mulDiv(supplyBefore - shares, supplyBefore);
    }
}
