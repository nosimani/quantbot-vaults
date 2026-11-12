const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { usdc, deployFixture, PROFIT_UNLOCK_PERIOD } = require("./helpers/fixture");

/**
 * Correcciones de seguridad pedidas en la revisión:
 *  1. La ganancia no entra de golpe en totalAssets (no se puede depositar justo antes y retirar justo después).
 *  2. Las pérdidas se dan de baja (sin deuda residual ni disparos espurios del circuit breaker).
 *  3. Las comisiones pendientes se descuentan en las vistas ERC-4626 (preview exactos).
 */
describe("Seguridad: ganancias graduales, pérdidas y comisiones pendientes", function () {
  const P = BigInt(PROFIT_UNLOCK_PERIOD);

  /** Alice deposita 1000 y el bot recibe 500. El atacante tiene fondos y allowance. */
  async function seeded() {
    const b = await deployFixture();
    await b.vault.connect(b.alice).deposit(usdc(1000), b.alice.address);
    await b.vault.connect(b.operator).allocate(b.strategyAddr, usdc(500));
    await b.token.mint(b.attacker.address, usdc(100_000));
    await b.token.connect(b.attacker).approve(b.vaultAddr, ethers.MaxUint256);
    return b;
  }

  describe("Ganancias: liberación gradual", function () {
    it("ATAQUE: depositar antes de la ganancia y retirar después ya NO deja rendimiento", async function () {
      const { vault, token, strategy, operator, attacker } = await loadFixture(seeded);
      const deposited = usdc(1000);
      const before = await token.balanceOf(attacker.address);

      await vault.connect(attacker).deposit(deposited, attacker.address); // justo antes de la ganancia
      await strategy.connect(operator).executeTrade(usdc(100)); // el bot reporta +100
      await vault.harvest();
      const shares = await vault.balanceOf(attacker.address);
      await vault.connect(attacker).redeem(shares, attacker.address, attacker.address); // justo después

      const profit = (await token.balanceOf(attacker.address)) - before;
      // Como máximo unos pocos segundos de liberación lineal (nunca el 50 % de la ganancia que antes se llevaba)
      expect(profit).to.be.lte((usdc(100) * 12n) / P + 10n);
      expect(profit).to.be.lt(usdc(1));
    });

    it("la ganancia reportada se libera de forma lineal", async function () {
      const { vault, strategy, operator } = await loadFixture(seeded);
      await strategy.connect(operator).executeTrade(usdc(100));

      expect(await vault.totalAssets()).to.be.closeTo(usdc(1000), usdc(1));
      await time.increase(PROFIT_UNLOCK_PERIOD / 2);
      expect(await vault.totalAssets()).to.be.closeTo(usdc(1050), usdc(1));
      await time.increase(PROFIT_UNLOCK_PERIOD / 2);
      expect(await vault.totalAssets()).to.equal(usdc(1100));
      expect(await vault.lockedProfitRemaining()).to.equal(0n);
    });

    it("una ganancia que nadie reportó (donación a la estrategia) no se cuenta hasta reportarla", async function () {
      const { vault, token, operator, strategyAddr } = await loadFixture(seeded);
      await token.connect(operator).transfer(strategyAddr, usdc(100));
      expect(await vault.totalAssets()).to.equal(usdc(1000));

      await expect(vault.harvest()).to.emit(vault, "GainReported").withArgs(strategyAddr, usdc(100));
      expect(await vault.totalAssets()).to.be.closeTo(usdc(1000), usdc(1));
      await time.increase(PROFIT_UNLOCK_PERIOD);
      expect(await vault.totalAssets()).to.equal(usdc(1100));
    });

    it("recall no permite saltear el bloqueo: la ganancia vuelve como liquidez pero sigue bloqueada", async function () {
      const { vault, token, strategy, operator, strategyAddr, vaultAddr } = await loadFixture(seeded);
      await strategy.connect(operator).executeTrade(usdc(100));
      await vault.connect(operator).recall(strategyAddr, usdc(600));

      expect(await token.balanceOf(vaultAddr)).to.equal(usdc(1100));
      expect(await vault.totalAssets()).to.be.closeTo(usdc(1000), usdc(1));
      await time.increase(PROFIT_UNLOCK_PERIOD);
      expect(await vault.totalAssets()).to.equal(usdc(1100));
    });

    it("emergencyRecallAll tampoco saltea el bloqueo", async function () {
      const { vault, token, operator, guardian, strategyAddr } = await loadFixture(seeded);
      await token.connect(operator).transfer(strategyAddr, usdc(100)); // ganancia sin reportar
      await vault.connect(guardian).emergencyRecallAll();

      expect((await vault.strategyInfo(strategyAddr)).debt).to.equal(0n);
      expect(await vault.totalAssets()).to.be.closeTo(usdc(1000), usdc(1));
      await time.increase(PROFIT_UNLOCK_PERIOD);
      expect(await vault.totalAssets()).to.equal(usdc(1100));
    });

    it("setProfitUnlockPeriod valida rango y permisos, y no produce saltos en totalAssets", async function () {
      const { vault, strategy, operator, attacker, owner } = await loadFixture(seeded);
      await strategy.connect(operator).executeTrade(usdc(100));
      await time.increase(PROFIT_UNLOCK_PERIOD / 2);
      const before = await vault.totalAssets();

      await expect(vault.connect(owner).setProfitUnlockPeriod(PROFIT_UNLOCK_PERIOD * 2))
        .to.emit(vault, "ProfitUnlockPeriodUpdated")
        .withArgs(PROFIT_UNLOCK_PERIOD * 2);
      expect(await vault.totalAssets()).to.be.closeTo(before, usdc(1));

      await expect(vault.setProfitUnlockPeriod(59)).to.be.revertedWithCustomError(vault, "InvalidUnlockPeriod").withArgs(59);
      await expect(vault.setProfitUnlockPeriod(7 * 24 * 3600 + 1)).to.be.revertedWithCustomError(vault, "InvalidUnlockPeriod");
      await expect(vault.connect(attacker).setProfitUnlockPeriod(3600)).to.be.revertedWithCustomError(
        vault,
        "AccessControlUnauthorizedAccount"
      );
    });
  });

  describe("Pérdidas", function () {
    it("la pérdida se refleja de inmediato en totalAssets y baja la deuda", async function () {
      const { vault, strategy, operator, strategyAddr } = await loadFixture(seeded);
      await expect(strategy.connect(operator).executeTrade(-usdc(50)))
        .to.emit(vault, "LossReported")
        .withArgs(strategyAddr, usdc(50));
      expect(await vault.totalAssets()).to.equal(usdc(950));
      expect((await vault.strategyInfo(strategyAddr)).debt).to.equal(usdc(450));
      expect((await vault.strategyInfo(strategyAddr)).active).to.equal(true); // 10 % exacto: dentro del límite
    });

    it("tras una pérdida y un recall total NO queda deuda residual ni se dispara de nuevo el circuit breaker", async function () {
      const { vault, strategy, operator, owner, strategyAddr } = await loadFixture(seeded);
      await strategy.connect(operator).executeTrade(-usdc(100)); // 20 %: se desactiva
      expect((await vault.strategyInfo(strategyAddr)).active).to.equal(false);

      await vault.connect(operator).recall(strategyAddr, usdc(400));
      expect((await vault.strategyInfo(strategyAddr)).debt).to.equal(0n);
      expect(await strategy.totalAssets()).to.equal(0n);

      await vault.connect(owner).activateStrategy(strategyAddr);
      expect(await vault.checkStrategyHealth.staticCall(strategyAddr)).to.equal(true);
      await expect(vault.checkStrategyHealth(strategyAddr)).to.not.emit(vault, "StrategyTripped");
      expect((await vault.strategyInfo(strategyAddr)).active).to.equal(true);
    });

    it("una pérdida consume primero la ganancia bloqueada (el total no cae por una ganancia y pérdida que se compensan)", async function () {
      const { vault, strategy, operator } = await loadFixture(seeded);
      await strategy.connect(operator).executeTrade(usdc(100)); // +100 bloqueada
      await strategy.connect(operator).executeTrade(-usdc(100)); // −100 (<= 20 % de 600)

      expect(await vault.totalAssets()).to.be.closeTo(usdc(1000), 1000n);
      await time.increase(PROFIT_UNLOCK_PERIOD);
      expect(await vault.totalAssets()).to.be.closeTo(usdc(1000), 1000n);
    });

    it("una estrategia que ya superó el drawdown no recibe capital aunque nadie la haya reportado", async function () {
      const { vault, strategy, operator, strategyAddr, vaultAddr } = await loadFixture(seeded);

      // Simula una pérdida sin reporte: la bóveda (impersonada) retira 100 sin actualizar su contabilidad.
      await impersonateAccount(vaultAddr);
      await setBalance(vaultAddr, ethers.parseEther("1"));
      const vaultSigner = await ethers.getSigner(vaultAddr);
      await strategy.connect(vaultSigner).withdraw(usdc(100));
      // (la estrategia valía 500 y ahora 400: -20 % con deuda reconocida de 500)

      await expect(vault.connect(operator).allocate(strategyAddr, usdc(1)))
        .to.be.revertedWithCustomError(vault, "StrategyInDrawdown")
        .withArgs(strategyAddr, usdc(500), usdc(400));
    });
  });

  describe("Comisión pendiente en las vistas ERC-4626", function () {
    /** Ganancia liberada por completo, todo el capital líquido y comisión devengada sin cobrar. */
    async function withPendingFee() {
      const b = await seeded();
      await b.strategy.connect(b.operator).executeTrade(usdc(100));
      await b.vault.connect(b.operator).recall(b.strategyAddr, usdc(600));
      await time.increase(PROFIT_UNLOCK_PERIOD);
      return b;
    }

    it("pendingFee informa la comisión devengada y previewRedeem la descuenta", async function () {
      const { vault, alice } = await loadFixture(withPendingFee);

      const [feeAssets, feeShares] = await vault.pendingFee();
      expect(feeAssets).to.be.closeTo(usdc(20), 1000n); // 20 % de 100
      expect(feeShares).to.be.gt(0n);

      const shares = await vault.balanceOf(alice.address);
      const preview = await vault.previewRedeem(shares);
      const total = await vault.totalAssets();
      const supply = await vault.totalSupply();
      const naive = (shares * (total + 1n)) / (supply + 1000n); // lo que prometía el cálculo sin comisión
      expect(preview).to.be.lt(naive);
    });

    it("redeem entrega exactamente lo que prometió previewRedeem", async function () {
      const { vault, token, alice } = await loadFixture(withPendingFee);
      const shares = await vault.balanceOf(alice.address);
      const preview = await vault.previewRedeem(shares);

      const before = await token.balanceOf(alice.address);
      await vault.connect(alice).redeem(shares, alice.address, alice.address);
      expect((await token.balanceOf(alice.address)) - before).to.equal(preview);
    });

    it("withdraw quema exactamente las shares que prometió previewWithdraw", async function () {
      const { vault, alice } = await loadFixture(withPendingFee);
      const preview = await vault.previewWithdraw(usdc(100));

      const before = await vault.balanceOf(alice.address);
      await vault.connect(alice).withdraw(usdc(100), alice.address, alice.address);
      expect(before - (await vault.balanceOf(alice.address))).to.equal(preview);
    });

    it("previewDeposit coincide con las shares acuñadas por deposit", async function () {
      const { vault, bob } = await loadFixture(withPendingFee);
      const preview = await vault.previewDeposit(usdc(500));
      const before = await vault.balanceOf(bob.address);
      await vault.connect(bob).deposit(usdc(500), bob.address);
      expect((await vault.balanceOf(bob.address)) - before).to.equal(preview);
    });

    it("después de cobrar la comisión ya no queda nada pendiente", async function () {
      const { vault, treasury } = await loadFixture(withPendingFee);
      await vault.harvest();
      const [feeAssets, feeShares] = await vault.pendingFee();
      expect(feeAssets).to.equal(0n);
      expect(feeShares).to.equal(0n);
      expect(await vault.balanceOf(treasury.address)).to.be.gt(0n);
    });
  });
});
