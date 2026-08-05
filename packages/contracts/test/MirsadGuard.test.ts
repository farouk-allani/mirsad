import { expect } from "chai";
import { ethers } from "hardhat";
import type { Signer } from "ethers";

/**
 * These tests run against the real Safe v1.4.1 contracts, not a mock. The
 * central claim of this project — "a vetoed transaction cannot execute even
 * if every owner signs it" — is only worth anything if it holds against the
 * actual Safe implementation a treasury runs.
 */

const AddressZero = "0x0000000000000000000000000000000000000000";

enum Operation {
  Call = 0,
  DelegateCall = 1,
}

enum Level {
  None = 0,
  Allow = 1,
  Warn = 2,
  Veto = 3,
}

interface SafeTx {
  to: string;
  value: bigint;
  data: string;
  operation: Operation;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: string;
  refundReceiver: string;
  nonce: bigint;
}

function safeTx(partial: Partial<SafeTx> & { to: string; nonce: bigint }): SafeTx {
  return {
    value: 0n,
    data: "0x",
    operation: Operation.Call,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: AddressZero,
    refundReceiver: AddressZero,
    ...partial,
  };
}

/**
 * Produce the packed signature blob Safe expects: each owner's EIP-712
 * signature, concatenated in ascending owner-address order.
 */
async function signSafeTx(safeAddress: string, chainId: bigint, tx: SafeTx, owners: Signer[]) {
  const domain = { chainId, verifyingContract: safeAddress };
  const types = {
    SafeTx: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
  };

  const signed = await Promise.all(
    owners.map(async (owner) => ({
      addr: (await owner.getAddress()).toLowerCase(),
      sig: await owner.signTypedData(domain, types, tx),
    })),
  );
  signed.sort((a, b) => (a.addr < b.addr ? -1 : 1));
  return "0x" + signed.map((s) => s.sig.slice(2)).join("");
}

async function deployFixture() {
  const wallets = await ethers.getSigners();
  const [deployer, alice, bob, carol, attacker] = wallets;
  const chainId = (await ethers.provider.getNetwork()).chainId;

  // --- Real Safe v1.4.1: singleton + proxy factory, 2-of-3 ---
  const singleton = await (await ethers.getContractFactory("Safe")).deploy();
  const factory = await (await ethers.getContractFactory("SafeProxyFactory")).deploy();

  const owners = [alice, bob, carol];
  const ownerAddrs = await Promise.all(owners.map((o) => o.getAddress()));
  const setupData = singleton.interface.encodeFunctionData("setup", [
    ownerAddrs,
    2, // threshold
    AddressZero,
    "0x",
    AddressZero,
    AddressZero,
    0,
    AddressZero,
  ]);

  const createTx = await factory.createProxyWithNonce(
    await singleton.getAddress(),
    setupData,
    Date.now(),
  );
  const receipt = await createTx.wait();
  const created = receipt!.logs
    .map((l) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l?.name === "ProxyCreation");
  const safeAddress = created!.args[0] as string;
  const safe = await ethers.getContractAt("Safe", safeAddress);

  // --- MIRSAD ---
  const writer = await deployer.getAddress();
  const registry = await (
    await ethers.getContractFactory("MirsadVerdictRegistry")
  ).deploy(writer);
  const guard = await (
    await ethers.getContractFactory("MirsadGuard")
  ).deploy(await registry.getAddress(), writer);

  return {
    deployer, alice, bob, carol, attacker,
    chainId, safe, safeAddress, registry, guard, owners,
  };
}

/** Execute a Safe transaction with the given owners' signatures. */
async function execute(
  ctx: Awaited<ReturnType<typeof deployFixture>>,
  tx: SafeTx,
  signers: Signer[],
) {
  const sigs = await signSafeTx(ctx.safeAddress, ctx.chainId, tx, signers);
  return ctx.safe.execTransaction(
    tx.to, tx.value, tx.data, tx.operation,
    tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver,
    sigs,
  );
}

/** Install MirsadGuard on the Safe. setGuard is self-authorized, so it must go through the Safe. */
async function installGuard(ctx: Awaited<ReturnType<typeof deployFixture>>) {
  const nonce = await ctx.safe.nonce();
  const tx = safeTx({
    to: ctx.safeAddress,
    nonce,
    data: ctx.safe.interface.encodeFunctionData("setGuard", [await ctx.guard.getAddress()]),
  });
  await (await execute(ctx, tx, [ctx.alice, ctx.bob])).wait();
}

describe("MirsadGuard + MirsadVerdictRegistry", () => {
  describe("the core guarantee", () => {
    it("blocks a vetoed transaction even when EVERY owner signs it", async () => {
      const ctx = await deployFixture();
      await installGuard(ctx);

      // The attack: drain 1 ETH to an address nobody recognises.
      await ctx.deployer.sendTransaction({ to: ctx.safeAddress, value: ethers.parseEther("5") });
      const nonce = await ctx.safe.nonce();
      const drain = safeTx({
        to: await ctx.attacker.getAddress(),
        value: ethers.parseEther("1"),
        nonce,
      });

      // MIRSAD sees it in the queue, simulates it, and vetoes it.
      const hash = await ctx.safe.getTransactionHash(
        drain.to, drain.value, drain.data, drain.operation,
        drain.safeTxGas, drain.baseGas, drain.gasPrice, drain.gasToken, drain.refundReceiver,
        nonce,
      );
      const reason = ethers.keccak256(ethers.toUtf8Bytes("unknown-recipient,value-drift"));
      await ctx.registry.setVerdict(hash, Level.Veto, reason);

      // All three owners sign — more than the 2-of-3 threshold requires.
      await expect(execute(ctx, drain, [ctx.alice, ctx.bob, ctx.carol]))
        .to.be.revertedWithCustomError(ctx.guard, "MirsadVeto")
        .withArgs(hash);

      // And the funds never moved.
      expect(await ethers.provider.getBalance(ctx.safeAddress)).to.equal(ethers.parseEther("5"));
    });

    it("allows an unvetoed transaction through untouched", async () => {
      const ctx = await deployFixture();
      await installGuard(ctx);
      await ctx.deployer.sendTransaction({ to: ctx.safeAddress, value: ethers.parseEther("5") });

      const before = await ethers.provider.getBalance(await ctx.attacker.getAddress());
      const tx = safeTx({
        to: await ctx.attacker.getAddress(),
        value: ethers.parseEther("1"),
        nonce: await ctx.safe.nonce(),
      });
      await (await execute(ctx, tx, [ctx.alice, ctx.bob])).wait();

      expect(await ethers.provider.getBalance(await ctx.attacker.getAddress()))
        .to.equal(before + ethers.parseEther("1"));
    });

    it("blocks a vetoed delegatecall — the Bybit shape", async () => {
      const ctx = await deployFixture();
      await installGuard(ctx);

      const nonce = await ctx.safe.nonce();
      const evil = safeTx({
        to: await ctx.attacker.getAddress(),
        data: "0xdeadbeef",
        operation: Operation.DelegateCall,
        nonce,
      });
      const hash = await ctx.safe.getTransactionHash(
        evil.to, evil.value, evil.data, evil.operation,
        evil.safeTxGas, evil.baseGas, evil.gasPrice, evil.gasToken, evil.refundReceiver,
        nonce,
      );
      await ctx.registry.setVerdict(hash, Level.Veto, ethers.id("hidden-delegatecall"));

      await expect(execute(ctx, evil, [ctx.alice, ctx.bob]))
        .to.be.revertedWithCustomError(ctx.guard, "MirsadVeto");
    });
  });

  describe("failure modes", () => {
    it("fails OPEN when MIRSAD has no verdict — a down watcher must not brick the treasury", async () => {
      const ctx = await deployFixture();
      await installGuard(ctx);
      await ctx.deployer.sendTransaction({ to: ctx.safeAddress, value: ethers.parseEther("2") });

      const tx = safeTx({
        to: await ctx.attacker.getAddress(),
        value: ethers.parseEther("1"),
        nonce: await ctx.safe.nonce(),
      });
      await expect(execute(ctx, tx, [ctx.alice, ctx.bob])).to.not.be.reverted;
    });

    it("fails CLOSED once an operator opts in via requireAssessment", async () => {
      const ctx = await deployFixture();
      await installGuard(ctx);
      await ctx.guard.setRequireAssessment(true);

      const tx = safeTx({
        to: await ctx.attacker.getAddress(),
        nonce: await ctx.safe.nonce(),
      });
      await expect(execute(ctx, tx, [ctx.alice, ctx.bob]))
        .to.be.revertedWithCustomError(ctx.guard, "MirsadNotAssessed");
    });

    it("lets a WARN through — only VETO blocks", async () => {
      const ctx = await deployFixture();
      await installGuard(ctx);

      const nonce = await ctx.safe.nonce();
      const tx = safeTx({ to: await ctx.attacker.getAddress(), nonce });
      const hash = await ctx.safe.getTransactionHash(
        tx.to, tx.value, tx.data, tx.operation,
        tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, nonce,
      );
      await ctx.registry.setVerdict(hash, Level.Warn, ethers.id("unusual-but-not-fatal"));

      await expect(execute(ctx, tx, [ctx.alice, ctx.bob])).to.not.be.reverted;
    });
  });

  describe("registry access control", () => {
    it("rejects writes from a non-writer", async () => {
      const { registry, attacker } = await deployFixture();
      await expect(
        registry.connect(attacker).setVerdict(ethers.id("x"), Level.Veto, ethers.ZeroHash),
      ).to.be.revertedWithCustomError(registry, "NotWriter");
    });

    it("accepts an idempotent replay of the same verdict", async () => {
      const { registry } = await deployFixture();
      const h = ethers.id("tx");
      const r = ethers.id("reason");
      await registry.setVerdict(h, Level.Veto, r);
      await expect(registry.setVerdict(h, Level.Veto, r)).to.not.be.reverted;
    });

    it("refuses to rewrite history with a different verdict", async () => {
      const { registry } = await deployFixture();
      const h = ethers.id("tx");
      await registry.setVerdict(h, Level.Veto, ethers.id("reason"));
      await expect(registry.setVerdict(h, Level.Allow, ethers.id("other")))
        .to.be.revertedWithCustomError(registry, "AlreadyAssessed");
    });

    it("supports the Safe guard interface so setGuard accepts it", async () => {
      const { guard } = await deployFixture();
      // Safe 1.4.1 checks this in setGuard; installGuard() succeeding in the
      // tests above is the real proof, this pins the id explicitly.
      expect(await guard.supportsInterface("0xe6d7a83a")).to.equal(true);
      expect(await guard.supportsInterface("0x01ffc9a7")).to.equal(true);
    });
  });
});
