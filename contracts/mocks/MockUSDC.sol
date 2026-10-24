// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockUSDC
/// @notice Stablecoin de prueba (6 decimales) con faucet. SOLO PARA TESTNET / TESTS.
/// @dev No usar en producción: cualquiera puede acuñar tokens mediante `faucet`.
contract MockUSDC is ERC20, Ownable {
    /// @notice Cantidad entregada por cada llamada exitosa a `faucet` (10.000 mUSDC).
    uint256 public constant FAUCET_AMOUNT = 10_000e6;

    /// @notice Tiempo mínimo entre dos llamadas al faucet de una misma cuenta.
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    /// @notice Timestamp del último retiro de faucet por cuenta.
    mapping(address account => uint256 timestamp) public lastFaucet;

    /// @notice Se emite cuando una cuenta reclama tokens del faucet.
    /// @param account Cuenta que recibe los tokens.
    /// @param amount Cantidad acuñada.
    event FaucetClaimed(address indexed account, uint256 amount);

    /// @notice El faucet todavía está en período de espera para la cuenta.
    /// @param availableAt Timestamp a partir del cual la cuenta puede volver a reclamar.
    error FaucetCooldown(uint256 availableAt);

    /// @notice Crea el token de prueba y define el owner que puede acuñar libremente.
    constructor() ERC20("Mock USD Coin", "mUSDC") Ownable(msg.sender) {}

    /// @notice Decimales del token (iguales a USDC real).
    /// @return Siempre 6.
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Entrega `FAUCET_AMOUNT` tokens a quien llama, respetando el cooldown.
    function faucet() external {
        uint256 availableAt = lastFaucet[msg.sender] + FAUCET_COOLDOWN;
        if (lastFaucet[msg.sender] != 0 && block.timestamp < availableAt) {
            revert FaucetCooldown(availableAt);
        }
        lastFaucet[msg.sender] = block.timestamp;
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Acuña tokens a una cuenta. Solo el owner.
    /// @param to Destinatario.
    /// @param amount Cantidad a acuñar (6 decimales).
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
