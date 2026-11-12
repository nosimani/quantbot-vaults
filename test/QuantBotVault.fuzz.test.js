const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { usdc, deployFixture, PROFIT_UNLOCK_PERIOD } = require("./helpers/fixture");

/**
 * Fuzzing con invariantes (sin dependencias extra): secuencias ALEATORIAS pero reproducibles
 * (generador con semilla) de depósitos, retiros, asignaciones, ganancias, pérdidas, donaciones,
 * harvest y paso del tiempo. Después de CADA operación se verifican invariantes del protocolo.
 *
 * Invariantes:
 *  I1. Solvencia: totalAssets nunca supera lo que el sistema realmente tiene (liquidez + estrategia).
 *  I2. Lo reclamable por todos los holders (usuarios + treasury) nunca supera totalAssets.
 *  I3. Conservación: todos los tokens están en cuentas conocidas (no se crean ni se pierden).
 *  I4. El precio por share (con comisión pendiente) no baja salvo por una pérdida reportada.
 *  I5. previewRedeem nunca promete más de lo que entrega redeem.
 *  I6. Sin almuerzo gratis: depositar antes de una ganancia y retirar justo después no da
 *      rendimiento apreciable (solo unos segundos de liberación lineal).
 *  I7. Al final, con todo recuperado y liberado, todos pueden retirar y no queda más que polvo.
 */

/** Generador pseudoaleatorio determinístico (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Fuzzing e invariantes (escenarios aleatorios)", function () {
  this.timeout(600_000);

  const P = BigInt(PROFIT_UNLOCK_PERIOD);
  const SEEDS = [1, 7, 42, 2024, 31337, 99999];
  const STEPS = 60;

  async function fuzzFixture() {
    const b = await deployFixture();
    for (const u of [b.alice, b.bob, b.attacker]) {
      await b.token.mint(u.address, usdc(1_000_000));
    }
    await b.token.mint(b.operator.address, usdc(1_000_000));
    await b.token.connect(b.attacker).approve(b.vaultAddr, ethers.MaxUint256);
    // Depósito base de Alice: la bóveda nunca queda vacía durante el fuzz.
    await b.vault.connect(b.alice).deposit(usdc(1000), b.alice.address);
    return b;
  }

  for (const seed of SEEDS) {
    it(`secuencia aleatoria con semilla ${seed}: se cumplen todas las invariantes`, async function () {
      const ctx = await loadFixture(fuzzFixture);
      const { vault, token, strategy, operator, guardian, owner, alice, bob, attacker, treasury, strategyAddr, vaultAddr } = ctx;
      const rand = rng(seed);
      const pick = (n) => Math.floor(rand() * n);
      const between = (lo, hi) => lo + pick(hi - lo + 1);

      const users = [alice, bob];
      const holders = [alice, bob, attacker, treasury];
      const everyone = [owner, operator, guardian, treasury, alice, bob, attacker];
      const tokenSupply = await token.totalSupply();
      const SINK = await strategy.LOSS_SINK();

      const pps = async () => vault.convertToAssets(10n ** 15n);
      let prevPps = await pps();

      const check = async (label) => {
        const where = `semilla ${seed}, paso ${label}`;
        const total = await vault.totalAssets();
        const idle = await token.balanceOf(vaultAddr);
        const live = await token.balanceOf(strategyAddr);

        // I1
        expect(total, `I1 solvencia (${where})`).to.be.lte(idle + live);
        // I2
        let claimable = 0n;
        for (const h of holders) claimable += await vault.convertToAssets(await vault.balanceOf(h.address));
        expect(claimable, `I2 reclamable <= total (${where})`).to.be.lte(total);
        // I3
        let sum = idle + live + (await token.balanceOf(SINK));
        for (const a of everyone) sum += await token.balanceOf(a.address);
        expect(sum, `I3 conservación de tokens (${where})`).to.equal(tokenSupply);
      };

      const checkPps = async (label, lossHappened) => {
        const now = await pps();
        if (!lossHappened) {
          expect(now, `I4 precio por share no baja (semilla ${seed}, paso ${label})`).to.be.gte(prevPps - prevPps / 1_000_000n);
        }
        prevPps = now;
      };

      await check("inicial");

      for (let i = 0; i < STEPS; i++) {
        const roll = rand();
        let op = "";
        let loss = false;
        try {
          if (roll < 0.22) {
            // Depósito de un usuario
            op = "deposit";
            const u = users[pick(2)];
            await vault.connect(u).deposit(usdc(between(1, 400)), u.address);
          } else if (roll < 0.36) {
            // Retiro parcial (verifica I5: preview <= entregado)
            op = "redeem";
            const u = users[pick(2)];
            const max = await vault.maxRedeem(u.address);
            const shares = (max * BigInt(between(10, 60))) / 100n;
            if (shares > 0n) {
              const preview = await vault.previewRedeem(shares);
              const before = await token.balanceOf(u.address);
              await vault.connect(u).redeem(shares, u.address, u.address);
              const got = (await token.balanceOf(u.address)) - before;
              expect(got + 2n, `I5 preview <= entregado (semilla ${seed}, paso ${i})`).to.be.gte(preview);
            }
          } else if (roll < 0.5) {
            // El bot asigna capital (puede revertir por límites: es parte del control de riesgo)
            op = "allocate";
            const idle = await token.balanceOf(vaultAddr);
            const amt = (idle * BigInt(between(5, 70))) / 100n;
            if (amt > 0n) await vault.connect(operator).allocate(strategyAddr, amt);
          } else if (roll < 0.6) {
            // El operador recupera capital
            op = "recall";
            const live = await token.balanceOf(strategyAddr);
            const amt = rand() < 0.4 ? live : (live * BigInt(between(10, 100))) / 100n;
            if (amt > 0n) await vault.connect(operator).recall(strategyAddr, amt);
          } else if (roll < 0.72) {
            // El bot reporta una ganancia
            op = "gain";
            await strategy.connect(operator).executeTrade(usdc(between(1, 100)));
          } else if (roll < 0.8) {
            // El bot reporta una pérdida (dentro del límite por operación)
            op = "loss";
            const live = await token.balanceOf(strategyAddr);
            const maxLoss = (live * 15n) / 100n;
            if (maxLoss >= usdc(1)) {
              await strategy.connect(operator).executeTrade(-(maxLoss * BigInt(between(10, 100))) / 100n);
              loss = true;
            }
          } else if (roll < 0.84) {
            // Donación directa a la estrategia (ganancia que nadie reportó)
            op = "donate";
            await token.connect(operator).transfer(strategyAddr, usdc(between(1, 30)));
          } else if (roll < 0.9) {
            op = "harvest";
            await vault.harvest();
          } else if (roll < 0.94) {
            // Pasa el tiempo (libera ganancias)
            op = "time";
            await time.increase(between(60, PROFIT_UNLOCK_PERIOD));
          } else if (roll < 0.96) {
            // El admin reactiva la estrategia si el circuit breaker la apagó
            op = "reactivate";
            await vault.connect(owner).activateStrategy(strategyAddr);
          } else {
            // I6: ataque oportunista (depositar antes de la ganancia y retirar justo después)
            op = "sandwich";
            const d = usdc(between(100, 2000));
            const g = usdc(between(10, 100));
            const info = await vault.strategyInfo(strategyAddr);
            const live = await token.balanceOf(strategyAddr);
            const unreported = live > info.debt ? live - info.debt : 0n;
            const locked = await vault.lockedProfitRemaining();

            const before = await token.balanceOf(attacker.address);
            await vault.connect(attacker).deposit(d, attacker.address);
            await strategy.connect(operator).executeTrade(g);
            await vault.harvest();
            const shares = await vault.balanceOf(attacker.address);
            await vault.connect(attacker).redeem(shares, attacker.address, attacker.address);
            const profit = (await token.balanceOf(attacker.address)) - before;

            const bound = ((g + unreported + locked) * 12n) / P + 10n;
            expect(profit, `I6 sin almuerzo gratis (semilla ${seed}, paso ${i})`).to.be.lte(bound);
          }
        } catch (e) {
          // Se aceptan reversiones del propio protocolo (límites de riesgo, liquidez, pausa);
          // cualquier otro error (incluidas aserciones fallidas) se propaga.
          if (e && e.name === "AssertionError") throw e;
          if (!/revert/i.test(String((e && e.message) || e))) throw e;
        }
        await check(`${i} (${op})`);
        await checkPps(`${i} (${op})`, loss);
      }

      // I7: cierre. Todo se recupera, se libera y todos retiran.
      const live = await token.balanceOf(strategyAddr);
      if (live > 0n) await vault.connect(operator).recall(strategyAddr, live);
      await time.increase(PROFIT_UNLOCK_PERIOD + 1);
      await vault.harvest();
      await check("cierre");

      // Se retira lo máximo permitido: por el offset de decimales de ERC-4626 el último holder
      // puede quedar con unas pocas unidades mínimas ("polvo") que no es posible canjear.
      for (const h of [alice, bob, attacker, treasury]) {
        const shares = await vault.balanceOf(h.address);
        const max = await vault.maxRedeem(h.address);
        const amount = shares < max ? shares : max;
        if (amount > 0n) await vault.connect(h).redeem(amount, h.address, h.address);
      }
      expect(await vault.totalAssets(), "I7 solo polvo en la bóveda").to.be.lte(usdc(1));
      expect(await token.balanceOf(vaultAddr), "I7 solo polvo en la bóveda (balance)").to.be.lte(usdc(1));
      expect(await token.balanceOf(strategyAddr)).to.equal(0n);
    });
  }
});
