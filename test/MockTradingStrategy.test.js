const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { usdc, deployFixture, MAX_LOSS_PER_TRADE_BPS } = require("./helpers/fixture");

describe("MockTradingStrategy", function () {
  it("expone asset, vault y límites configurados", async function () {
    const { strategy, tokenAddr, vaultAddr } = await loadFixture(deployFixture);
    expect(await strategy.asset()).to.equal(tokenAddr);
    expect(await strategy.vault()).to.equal(vaultAddr);
    expect(await strategy.maxLossPerTradeBps()).to.equal(MAX_LOSS_PER_TRADE_BPS);
  });

  it("solo el bot puede reportar operaciones", async function () {
    const { strategy, attacker } = await loadFixture(deployFixture);
    await expect(strategy.connect(attacker).executeTrade(usdc(1)))
      .to.be.revertedWithCustomError(strategy, "AccessControlUnauthorizedAccount")
      .withArgs(attacker.address, await strategy.BOT_ROLE());
  });

  it("rechaza pnl cero", async function () {
    const { strategy, operator } = await loadFixture(deployFixture);
    await expect(strategy.connect(operator).executeTrade(0)).to.be.revertedWithCustomError(strategy, "ZeroPnl");
  });

  it("rechaza pérdidas por encima del límite por operación", async function () {
    const { vault, strategy, operator, alice, strategyAddr } = await loadFixture(deployFixture);
    await vault.connect(alice).deposit(usdc(1000), alice.address);
    await vault.connect(operator).allocate(strategyAddr, usdc(500));
    await expect(strategy.connect(operator).executeTrade(-usdc(101)))
      .to.be.revertedWithCustomError(strategy, "TradeLossTooLarge")
      .withArgs(usdc(101), usdc(100));
  });

  it("una pérdida válida se envía al sumidero y reduce totalAssets", async function () {
    const { vault, token, strategy, operator, alice, strategyAddr } = await loadFixture(deployFixture);
    await vault.connect(alice).deposit(usdc(1000), alice.address);
    await vault.connect(operator).allocate(strategyAddr, usdc(500));
    await strategy.connect(operator).executeTrade(-usdc(50));
    expect(await strategy.totalAssets()).to.equal(usdc(450));
    expect(await token.balanceOf(await strategy.LOSS_SINK())).to.equal(usdc(50));
  });

  it("una ganancia exige allowance del bot", async function () {
    const { token, strategy, operator, strategyAddr } = await loadFixture(deployFixture);
    await token.connect(operator).approve(strategyAddr, 0);
    await expect(strategy.connect(operator).executeTrade(usdc(10))).to.be.revertedWithCustomError(
      token,
      "ERC20InsufficientAllowance"
    );
  });

  it("withdraw solo puede ser llamado por la bóveda", async function () {
    const { strategy, attacker } = await loadFixture(deployFixture);
    await expect(strategy.connect(attacker).withdraw(1))
      .to.be.revertedWithCustomError(strategy, "NotVault")
      .withArgs(attacker.address);
  });

  it("valida el constructor", async function () {
    const { Strategy, tokenAddr, vaultAddr, owner } = await loadFixture(deployFixture);
    await expect(Strategy.deploy(ethers.ZeroAddress, vaultAddr, owner.address, 1000)).to.be.revertedWithCustomError(
      Strategy,
      "ZeroAddress"
    );
    await expect(Strategy.deploy(tokenAddr, ethers.ZeroAddress, owner.address, 1000)).to.be.revertedWithCustomError(
      Strategy,
      "ZeroAddress"
    );
    await expect(Strategy.deploy(tokenAddr, vaultAddr, ethers.ZeroAddress, 1000)).to.be.revertedWithCustomError(
      Strategy,
      "ZeroAddress"
    );
    await expect(Strategy.deploy(tokenAddr, vaultAddr, owner.address, 0)).to.be.revertedWithCustomError(
      Strategy,
      "InvalidBps"
    );
    await expect(Strategy.deploy(tokenAddr, vaultAddr, owner.address, 10_001)).to.be.revertedWithCustomError(
      Strategy,
      "InvalidBps"
    );
  });
});
