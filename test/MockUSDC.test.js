const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { usdc, deployFixture } = require("./helpers/fixture");

describe("MockUSDC (token de prueba)", function () {
  it("usa 6 decimales", async function () {
    const { token } = await loadFixture(deployFixture);
    expect(await token.decimals()).to.equal(6);
  });

  it("faucet entrega tokens y aplica cooldown", async function () {
    const { token, attacker } = await loadFixture(deployFixture);
    await expect(token.connect(attacker).faucet())
      .to.emit(token, "FaucetClaimed")
      .withArgs(attacker.address, usdc(10_000));
    expect(await token.balanceOf(attacker.address)).to.equal(usdc(10_000));

    await expect(token.connect(attacker).faucet()).to.be.revertedWithCustomError(token, "FaucetCooldown");

    await time.increase(3600);
    await expect(token.connect(attacker).faucet()).to.not.be.reverted;
    expect(await token.balanceOf(attacker.address)).to.equal(usdc(20_000));
  });

  it("mint solo para el owner", async function () {
    const { token, attacker, owner } = await loadFixture(deployFixture);
    await expect(token.connect(attacker).mint(attacker.address, 1))
      .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
      .withArgs(attacker.address);
    await token.connect(owner).mint(attacker.address, 5);
    expect(await token.balanceOf(attacker.address)).to.equal(5n);
  });
});
