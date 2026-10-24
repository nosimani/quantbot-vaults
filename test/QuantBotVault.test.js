const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const {
  usdc,
  deployFixture,
  FEE_BPS,
  DEPOSIT_CAP,
  MIN_IDLE_BPS,
  MAX_DRAWDOWN_BPS,
  STRATEGY_CAP_BPS,
} = require("./helpers/fixture");

describe("QuantBotVault", function () {
  // ---------------------------------------------------------------------
  describe("Despliegue y configuración", function () {
    it("inicializa parámetros, roles y metadatos", async function () {
      const { vault, owner, treasury, tokenAddr, operator, guardian } = await loadFixture(deployFixture);

      expect(await vault.asset()).to.equal(tokenAddr);
      expect(await vault.name()).to.equal("QuantBot Vault Shares");
      expect(await vault.symbol()).to.equal("qbvUSDC");
      expect(await vault.treasury()).to.equal(treasury.address);
      expect(await vault.performanceFeeBps()).to.equal(FEE_BPS);
      expect(await vault.depositCap()).to.equal(DEPOSIT_CAP);
      expect(await vault.minIdleBps()).to.equal(MIN_IDLE_BPS);
      expect(await vault.maxDrawdownBps()).to.equal(MAX_DRAWDOWN_BPS);

      expect(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), owner.address)).to.equal(true);
      expect(await vault.hasRole(await vault.OPERATOR_ROLE(), operator.address)).to.equal(true);
      expect(await vault.hasRole(await vault.GUARDIAN_ROLE(), guardian.address)).to.equal(true);
    });

    it("revierte con parámetros inválidos en el constructor", async function () {
      const { Vault, owner, treasury, tokenAddr } = await loadFixture(deployFixture);
      const args = (over = {}) => {
        const a = {
          admin: owner.address,
          treasury: treasury.address,
          fee: FEE_BPS,
          cap: DEPOSIT_CAP,
          idle: MIN_IDLE_BPS,
          dd: MAX_DRAWDOWN_BPS,
          ...over,
        };
        return [tokenAddr, "N", "S", a.admin, a.treasury, a.fee, a.cap, a.idle, a.dd];
      };

      await expect(Vault.deploy(...args({ admin: ethers.ZeroAddress }))).to.be.revertedWithCustomError(Vault, "ZeroAddress");
      await expect(Vault.deploy(...args({ treasury: ethers.ZeroAddress }))).to.be.revertedWithCustomError(Vault, "ZeroAddress");
      await expect(Vault.deploy(...args({ fee: 3001 })))
        .to.be.revertedWithCustomError(Vault, "FeeTooHigh")
        .withArgs(3001, 3000);
      await expect(Vault.deploy(...args({ idle: 10001 }))).to.be.revertedWithCustomError(Vault, "InvalidBps");
      await expect(Vault.deploy(...args({ dd: 10001 }))).to.be.revertedWithCustomError(Vault, "InvalidBps");
    });
  });

  // ---------------------------------------------------------------------
  describe("Depósitos y retiros (ERC-4626)", function () {
    it("deposit acuña shares, emite evento y aumenta totalAssets", async function () {
      const { vault, token, alice } = await loadFixture(deployFixture);

      await expect(vault.connect(alice).deposit(usdc(1000), alice.address)).to.emit(vault, "Deposit");

      expect(await vault.totalAssets()).to.equal(usdc(1000));
      expect(await token.balanceOf(await vault.getAddress())).to.equal(usdc(1000));
      expect(await vault.convertToAssets(await vault.balanceOf(alice.address))).to.be.closeTo(usdc(1000), 1000n);
      expect(await vault.lastTotalAssets()).to.equal(usdc(1000));
    });

    it("mint acuña exactamente las shares pedidas", async function () {
      const { vault, alice } = await loadFixture(deployFixture);
      const shares = 1_000_000_000_000n; // 1000 mUSDC con offset de 3 decimales
      await vault.connect(alice).mint(shares, alice.address);
      expect(await vault.balanceOf(alice.address)).to.equal(shares);
      expect(await vault.totalAssets()).to.equal(usdc(1000));
    });

    it("redeem devuelve los activos depositados cuando no hubo ganancias", async function () {
      const { vault, token, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(usdc(1000), alice.address);
      const before = await token.balanceOf(alice.address);

      const shares = await vault.balanceOf(alice.address);
      await vault.connect(alice).redeem(shares, alice.address, alice.address);

      expect((await token.balanceOf(alice.address)) - before).to.be.closeTo(usdc(1000), 1000n);
      expect(await vault.totalSupply()).to.equal(0n);
      expect(await vault.lastTotalAssets()).to.equal(0n);
    });

    it("withdraw entrega el monto exacto de activos", async function () {
      const { vault, token, alice } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(usdc(1000), alice.address);
      const before = await token.balanceOf(alice.address);
      await vault.connect(alice).withdraw(usdc(400), alice.address, alice.address);
      expect((await token.balanceOf(alice.address)) - before).to.equal(usdc(400));
    });

    it("respeta el tope de depósitos (depositCap)", async function () {
      const { vault, alice, bob, owner } = await loadFixture(deployFixture);
      await expect(vault.setDepositCap(usdc(1500))).to.emit(vault, "DepositCapUpdated").withArgs(usdc(1500));
      await vault.connect(alice).deposit(usdc(1000), alice.address);

      expect(await vault.maxDeposit(bob.address)).to.equal(usdc(500));
      await expect(vault.connect(bob).deposit(usdc(600), bob.address))
        .to.be.revertedWithCustomError(vault, "ERC4626ExceededMaxDeposit")
        .withArgs(bob.address, usdc(600), usdc(500));
      await expect(vault.connect(bob).deposit(usdc(500), bob.address)).to.not.be.reverted;
      expect(await vault.maxDeposit(bob.address)).to.equal(0n);
      expect(owner.address).to.not.equal(undefined);
    });

    it("el retiro está limitado por la liquidez del vault", async function () {
      const { vault, operator, alice, strategyAddr } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(usdc(1000), alice.address);
      await vault.connect(operator).allocate(strategyAddr, usdc(500));

      expect(await vault.maxWithdraw(alice.address)).to.equal(usdc(500));
      await expect(vault.connect(alice).withdraw(usdc(600), alice.address, alice.address)).to.be.revertedWithCustomError(
        vault,
        "ERC4626ExceededMaxWithdraw"
      );
      await expect(vault.connect(alice).withdraw(usdc(500), alice.address, alice.address)).to.not.be.reverted;
    });
  });

  // ---------------------------------------------------------------------
  describe("Asignación de capital al bot (allocate / recall)", function () {
    it("FLUJO PRINCIPAL: deposita, asigna, el bot genera ganancia, se cobra fee y se retira con rendimiento", async function () {
      const { vault, token, strategy, operator, alice, treasury, strategyAddr } = await loadFixture(deployFixture);

      // 1) El usuario deposita
      await vault.connect(alice).deposit(usdc(1000), alice.address);

      // 2) El bot asigna capital a la estrategia
      await expect(vault.connect(operator).allocate(strategyAddr, usdc(500)))
        .to.emit(vault, "Allocated")
        .withArgs(strategyAddr, usdc(500));
      expect(await token.balanceOf(strategyAddr)).to.equal(usdc(500));
      expect(await vault.totalAssets()).to.equal(usdc(1000)); // el valor total no cambia al asignar
      expect((await vault.strategyInfo(strategyAddr)).debt).to.equal(usdc(500));

      // 3) El bot reporta una ganancia de 100 mUSDC
      await expect(strategy.connect(operator).executeTrade(usdc(100)))
        .to.emit(strategy, "TradeExecuted")
        .withArgs(operator.address, usdc(100), usdc(600));
      expect(await vault.totalAssets()).to.equal(usdc(1100));

      // 4) Se cobra la comisión (20 % de 100 = 20 mUSDC) acuñando shares al treasury
      await expect(vault.harvest()).to.emit(vault, "FeeAccrued");
      const treasuryAssets = await vault.convertToAssets(await vault.balanceOf(treasury.address));
      expect(treasuryAssets).to.be.closeTo(usdc(20), 1000n);

      // 5) El operador recupera el capital y el usuario retira con ganancia neta de fee (~80)
      await expect(vault.connect(operator).recall(strategyAddr, usdc(600))).to.emit(vault, "Recalled");
      expect((await vault.strategyInfo(strategyAddr)).debt).to.equal(0n);

      const before = await token.balanceOf(alice.address);
      const shares = await vault.balanceOf(alice.address);
      await vault.connect(alice).redeem(shares, alice.address, alice.address);
      expect((await token.balanceOf(alice.address)) - before).to.be.closeTo(usdc(1080), 1000n);
    });

    it("solo el operador puede asignar", async function () {
      const { vault, attacker, guardian, strategyAddr } = await loadFixture(deployFixture);
      const role = await vault.OPERATOR_ROLE();
      await expect(vault.connect(attacker).allocate(strategyAddr, 1))
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
        .withArgs(attacker.address, role);
      await expect(vault.connect(guardian).allocate(strategyAddr, 1))
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
        .withArgs(guardian.address, role);
    });

    it("el operador no puede enviar fondos a una dirección que no es estrategia registrada", async function () {
      const { vault, operator, attacker } = await loadFixture(deployFixture);
      await expect(vault.connect(operator).allocate(attacker.address, usdc(1)))
        .to.be.revertedWithCustomError(vault, "StrategyNotRegistered")
        .withArgs(attacker.address);
    });

    it("revierte si el monto es cero", async function () {
      const { vault, operator, strategyAddr } = await loadFixture(deployFixture);
      await expect(vault.connect(operator).allocate(strategyAddr, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("revierte si supera la liquidez disponible", async function () {
      const { vault, operator, alice, strategyAddr } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(usdc(1000), alice.address);
      await expect(vault.connect(operator).allocate(strategyAddr, usdc(1001)))
        .to.be.revertedWithCustomError(vault, "InsufficientIdle")
        .withArgs(usdc(1001), usdc(1000));
    });

    it("revierte si supera el tope por estrategia", async function () {
      const { vault, operator, alice, strategyAddr } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(usdc(1000), alice.address);
      await expect(vault.connect(operator).allocate(strategyAddr, usdc(600)))
        .to.be.revertedWithCustomError(vault, "AllocationCapExceeded")
        .withArgs(usdc(600), usdc(500));
    });

    it("revierte si viola la reserva mínima de liquidez", async function () {
      const { vault, operator, alice, strategyAddr } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(usdc(1000), alice.address);
      await vault.setStrategyCap(strategyAddr, 10_000);
      await expect(vault.connect(operator).allocate(strategyAddr, usdc(950)))
        .to.be.revertedWithCustomError(vault, "MinIdleReserveBreached")
        .withArgs(usdc(50), usdc(100));
    });

    it("recall: operador o guardián pueden recuperar; otros no", async function () {
      const { vault, operator, guardian, attacker, alice, strategyAddr } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(usdc(1000), alice.address);
      await vault.connect(operator).allocate(strategyAddr, usdc(500));

      await expect(vault.connect(attacker).recall(strategyAddr, usdc(1)))
        .to.be.revertedWithCustomError(vault, "NotOperatorOrGuardian")
        .withArgs(attacker.address);
      await expect(vault.connect(operator).recall(strategyAddr, 0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
      await vault.connect(guardian).recall(strategyAddr, usdc(200));
      expect((await vault.strategyInfo(strategyAddr)).debt).to.equal(usdc(300));
      await vault.connect(operator).recall(strategyAddr, usdc(300));
      expect((await vault.strategyInfo(strategyAddr)).debt).to.equal(0n);
    });
  });

  // ---------------------------------------------------------------------
  describe("Pérdidas, circuit breaker y comisiones (high-water mark)", function () {
    async function allocatedFixture() {
      const base = await deployFixture();
      await base.vault.connect(base.alice).deposit(usdc(1000), base.alice.address);
      await base.vault.connect(base.operator).allocate(base.strategyAddr, usdc(500));
      return base;
    }

    it("el circuit breaker desactiva una estrategia que supera el drawdown máximo", async function () {
      const { vault, strategy, operator, strategyAddr } = await loadFixture(allocatedFixture);

      // Pérdida de 100 sobre 500 = 20 % > 10 % permitido
      await strategy.connect(operator).executeTrade(-usdc(100));
      expect(await vault.totalAssets()).to.equal(usdc(900));

      expect(await vault.checkStrategyHealth.staticCall(strategyAddr)).to.equal(false);
      await expect(vault.checkStrategyHealth(strategyAddr))
        .to.emit(vault, "StrategyTripped")
        .withArgs(strategyAddr, usdc(500), usdc(400));

      expect((await vault.strategyInfo(strategyAddr)).active).to.equal(false);
      await expect(vault.connect(operator).allocate(strategyAddr, usdc(1)))
        .to.be.revertedWithCustomError(vault, "StrategyNotActive")
        .withArgs(strategyAddr);
    });

    it("una estrategia dentro del drawdown se considera saludable", async function () {
      const { vault, strategy, operator, strategyAddr } = await loadFixture(allocatedFixture);
      await strategy.connect(operator).executeTrade(-usdc(25)); // 5 %
      expect(await vault.checkStrategyHealth.staticCall(strategyAddr)).to.equal(true);
    });

    it("no cobra comisión sobre una recuperación hasta superar el high-water mark", async function () {
      const { vault, strategy, operator, treasury } = await loadFixture(allocatedFixture);

      await strategy.connect(operator).executeTrade(-usdc(100)); // total 900 (HWM 1000)
      await vault.harvest();
      await strategy.connect(operator).executeTrade(usdc(50)); // total 950 < 1000
      await vault.harvest();
      expect(await vault.balanceOf(treasury.address)).to.equal(0n);

      await strategy.connect(operator).executeTrade(usdc(100)); // total 1050 > 1000
      await vault.harvest();
      const feeAssets = await vault.convertToAssets(await vault.balanceOf(treasury.address));
      expect(feeAssets).to.be.closeTo(usdc(10), 1000n); // 20 % de 50
    });

    it("un depósito nuevo no se cobra como ganancia", async function () {
      const { vault, bob, treasury } = await loadFixture(allocatedFixture);
      await vault.connect(bob).deposit(usdc(1000), bob.address);
      await vault.harvest();
      expect(await vault.balanceOf(treasury.address)).to.equal(0n);
    });

    it("el guardián puede desactivar manualmente y el admin reactivar", async function () {
      const { vault, guardian, owner, strategyAddr, attacker } = await loadFixture(deployFixture);
      await expect(vault.connect(guardian).deactivateStrategy(strategyAddr))
        .to.emit(vault, "StrategyDeactivated")
        .withArgs(strategyAddr);
      await expect(vault.connect(attacker).activateStrategy(strategyAddr)).to.be.revertedWithCustomError(
        vault,
        "AccessControlUnauthorizedAccount"
      );
      await expect(vault.connect(owner).activateStrategy(strategyAddr)).to.emit(vault, "StrategyActivated");
    });
  });

  // ---------------------------------------------------------------------
  describe("Pausa y emergencias", function () {
    it("en pausa se bloquean depósitos y asignaciones, pero los retiros siguen", async function () {
      const { vault, guardian, owner, operator, alice, bob, strategyAddr } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(usdc(1000), alice.address);

      await vault.connect(guardian).pause();
      expect(await vault.maxDeposit(bob.address)).to.equal(0n);
      await expect(vault.connect(bob).deposit(usdc(1), bob.address)).to.be.revertedWithCustomError(
        vault,
        "ERC4626ExceededMaxDeposit"
      );
      await expect(vault.connect(operator).allocate(strategyAddr, usdc(1))).to.be.revertedWithCustomError(
        vault,
        "EnforcedPause"
      );

      // Retiro permitido en pausa
      const shares = await vault.balanceOf(alice.address);
      await expect(vault.connect(alice).redeem(shares, alice.address, alice.address)).to.not.be.reverted;

      // Solo el admin reanuda
      await expect(vault.connect(guardian).unpause()).to.be.revertedWithCustomError(
        vault,
        "AccessControlUnauthorizedAccount"
      );
      await vault.connect(owner).unpause();
      await expect(vault.connect(bob).deposit(usdc(1), bob.address)).to.not.be.reverted;
    });

    it("solo el guardián puede pausar", async function () {
      const { vault, attacker } = await loadFixture(deployFixture);
      await expect(vault.connect(attacker).pause()).to.be.revertedWithCustomError(
        vault,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("emergencyRecallAll pausa y devuelve todo el capital al vault", async function () {
      const { vault, token, guardian, operator, alice, strategyAddr, vaultAddr } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(usdc(1000), alice.address);
      await vault.connect(operator).allocate(strategyAddr, usdc(500));

      await expect(vault.connect(guardian).emergencyRecallAll())
        .to.emit(vault, "EmergencyRecall")
        .withArgs(guardian.address);

      expect(await vault.paused()).to.equal(true);
      expect(await token.balanceOf(strategyAddr)).to.equal(0n);
      expect(await token.balanceOf(vaultAddr)).to.equal(usdc(1000));
      expect((await vault.strategyInfo(strategyAddr)).debt).to.equal(0n);
    });

    it("emergencyRecallAll está restringido al guardián", async function () {
      const { vault, operator } = await loadFixture(deployFixture);
      await expect(vault.connect(operator).emergencyRecallAll()).to.be.revertedWithCustomError(
        vault,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  // ---------------------------------------------------------------------
  describe("Administración de estrategias y parámetros", function () {
    it("addStrategy valida cero, duplicados, bps y compatibilidad", async function () {
      const { vault, Strategy, tokenAddr, owner, attacker, strategyAddr, vaultAddr } = await loadFixture(deployFixture);

      await expect(vault.addStrategy(ethers.ZeroAddress, 1000)).to.be.revertedWithCustomError(vault, "ZeroAddress");
      await expect(vault.addStrategy(strategyAddr, 1000))
        .to.be.revertedWithCustomError(vault, "StrategyAlreadyRegistered")
        .withArgs(strategyAddr);

      const other = await Strategy.deploy(tokenAddr, vaultAddr, owner.address, 1000);
      await expect(vault.addStrategy(await other.getAddress(), 0)).to.be.revertedWithCustomError(vault, "InvalidBps");
      await expect(vault.addStrategy(await other.getAddress(), 10_001)).to.be.revertedWithCustomError(vault, "InvalidBps");

      // Estrategia apuntando a otra bóveda
      const wrongVault = await Strategy.deploy(tokenAddr, attacker.address, owner.address, 1000);
      await expect(vault.addStrategy(await wrongVault.getAddress(), 1000))
        .to.be.revertedWithCustomError(vault, "StrategyMismatch")
        .withArgs(await wrongVault.getAddress());

      await expect(vault.connect(attacker).addStrategy(await other.getAddress(), 1000)).to.be.revertedWithCustomError(
        vault,
        "AccessControlUnauthorizedAccount"
      );
    });

    it("limita la cantidad de estrategias a MAX_STRATEGIES", async function () {
      const { vault, Strategy, tokenAddr, owner, vaultAddr } = await loadFixture(deployFixture);
      const max = Number(await vault.MAX_STRATEGIES());
      for (let i = 1; i < max; i++) {
        const s = await Strategy.deploy(tokenAddr, vaultAddr, owner.address, 1000);
        await vault.addStrategy(await s.getAddress(), 1000);
      }
      expect(await vault.strategiesLength()).to.equal(max);
      const extra = await Strategy.deploy(tokenAddr, vaultAddr, owner.address, 1000);
      await expect(vault.addStrategy(await extra.getAddress(), 1000)).to.be.revertedWithCustomError(
        vault,
        "TooManyStrategies"
      );
    });

    it("removeStrategy exige que esté vacía", async function () {
      const { vault, operator, alice, strategyAddr } = await loadFixture(deployFixture);
      await vault.connect(alice).deposit(usdc(1000), alice.address);
      await vault.connect(operator).allocate(strategyAddr, usdc(500));

      await expect(vault.removeStrategy(strategyAddr))
        .to.be.revertedWithCustomError(vault, "StrategyNotEmpty")
        .withArgs(strategyAddr, usdc(500));

      await vault.connect(operator).recall(strategyAddr, usdc(500));
      await expect(vault.removeStrategy(strategyAddr)).to.emit(vault, "StrategyRemoved").withArgs(strategyAddr);
      expect(await vault.strategiesLength()).to.equal(0n);
      expect((await vault.strategyInfo(strategyAddr)).registered).to.equal(false);
      await expect(vault.removeStrategy(strategyAddr)).to.be.revertedWithCustomError(vault, "StrategyNotRegistered");
    });

    it("setStrategyCap actualiza el tope y valida", async function () {
      const { vault, strategyAddr, attacker } = await loadFixture(deployFixture);
      await expect(vault.setStrategyCap(strategyAddr, 7000))
        .to.emit(vault, "StrategyCapUpdated")
        .withArgs(strategyAddr, 7000);
      expect((await vault.strategyInfo(strategyAddr)).maxAllocationBps).to.equal(7000);
      await expect(vault.setStrategyCap(strategyAddr, 0)).to.be.revertedWithCustomError(vault, "InvalidBps");
      await expect(vault.setStrategyCap(attacker.address, 1000)).to.be.revertedWithCustomError(
        vault,
        "StrategyNotRegistered"
      );
    });

    it("setters de parámetros: validan límites y permisos", async function () {
      const { vault, attacker, alice } = await loadFixture(deployFixture);

      await expect(vault.setPerformanceFeeBps(1000)).to.emit(vault, "PerformanceFeeUpdated").withArgs(1000);
      await expect(vault.setPerformanceFeeBps(3001))
        .to.be.revertedWithCustomError(vault, "FeeTooHigh")
        .withArgs(3001, 3000);

      await expect(vault.setTreasury(alice.address)).to.emit(vault, "TreasuryUpdated").withArgs(alice.address);
      await expect(vault.setTreasury(ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "ZeroAddress");

      await expect(vault.setMinIdleBps(2000)).to.emit(vault, "MinIdleBpsUpdated").withArgs(2000);
      await expect(vault.setMinIdleBps(10_001)).to.be.revertedWithCustomError(vault, "InvalidBps");

      await expect(vault.setMaxDrawdownBps(500)).to.emit(vault, "MaxDrawdownBpsUpdated").withArgs(500);
      await expect(vault.setMaxDrawdownBps(10_001)).to.be.revertedWithCustomError(vault, "InvalidBps");

      for (const call of [
        () => vault.connect(attacker).setPerformanceFeeBps(1),
        () => vault.connect(attacker).setTreasury(attacker.address),
        () => vault.connect(attacker).setDepositCap(1),
        () => vault.connect(attacker).setMinIdleBps(1),
        () => vault.connect(attacker).setMaxDrawdownBps(1),
        () => vault.connect(attacker).removeStrategy(attacker.address),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
      }
    });
  });

  // ---------------------------------------------------------------------
  describe("Invariantes", function () {
    it("la suma de lo retirable por todos nunca excede totalAssets (secuencia determinística)", async function () {
      const { vault, alice, bob, operator, strategy, strategyAddr } = await loadFixture(deployFixture);
      const users = [alice, bob];
      const amounts = [137, 842, 59, 301, 777, 12, 460];

      for (let i = 0; i < amounts.length; i++) {
        const u = users[i % 2];
        await vault.connect(u).deposit(usdc(amounts[i]), u.address);
        if (i === 2) await vault.connect(operator).allocate(strategyAddr, usdc(100));
        if (i === 3) await strategy.connect(operator).executeTrade(usdc(30));
        if (i === 5) await strategy.connect(operator).executeTrade(-usdc(10));
        if (i % 3 === 0) {
          const max = await vault.maxWithdraw(u.address);
          if (max > 0n) await vault.connect(u).withdraw(max / 2n, u.address, u.address);
        }

        const total = await vault.totalAssets();
        const claimable =
          (await vault.convertToAssets(await vault.balanceOf(alice.address))) +
          (await vault.convertToAssets(await vault.balanceOf(bob.address))) +
          (await vault.convertToAssets(await vault.balanceOf(await vault.treasury())));
        expect(claimable).to.be.lte(total);
      }
    });
  });
});
