import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { safeTx, signSafeTx, execArgs, AddressZero } from "../lib/safeTx";

/**
 * Deploys the demo treasury: a real 2-of-3 Safe v1.4.1 on Sepolia, with
 * MirsadGuard installed.
 *
 * Uses the canonical Safe deployment rather than our own copy, so the demo runs
 * against exactly the contracts a real treasury runs. The three owner keys are
 * throwaway and derived from a mnemonic kept in .env; only the deployer needs
 * ETH, because owners sign offchain and never broadcast.
 */

const SAFE_SINGLETON_141 = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
const SAFE_PROXY_FACTORY_141 = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const ENV_PATH = path.resolve(__dirname, "../../../.env");

/** Owner keys are demo-only and testnet-only. Persisted so the demo is repeatable. */
function loadOrCreateMnemonic(): string {
  const existing = process.env.DEMO_SAFE_MNEMONIC?.trim();
  if (existing) return existing;

  const phrase = ethers.Wallet.createRandom().mnemonic!.phrase;
  const line = `\n# Throwaway owner keys for the demo Safe. Testnet only, no value.\nDEMO_SAFE_MNEMONIC="${phrase}"\n`;
  fs.appendFileSync(ENV_PATH, line);
  console.log("generated a demo owner mnemonic and appended it to .env");
  return phrase;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;
  console.log(`network  : ${network.name} (${chainId})`);
  console.log(`deployer : ${await deployer.getAddress()}`);

  const registryAddress = process.env.MIRSAD_REGISTRY_ADDRESS;
  const guardAddress = process.env.MIRSAD_GUARD_ADDRESS;
  if (!registryAddress || !guardAddress) {
    throw new Error("Run scripts/deploy.ts first: MIRSAD_REGISTRY_ADDRESS / MIRSAD_GUARD_ADDRESS unset");
  }

  // --- owners ---
  const mnemonic = loadOrCreateMnemonic();
  const owners = [0, 1, 2].map((i) =>
    ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${i}`).connect(
      ethers.provider,
    ),
  );
  const ownerAddrs = owners.map((o) => o.address);
  console.log(`owners   : ${ownerAddrs.join("\n           ")}`);
  console.log(`threshold: 2 of 3\n`);

  // --- deploy the Safe via the canonical factory ---
  const factory = await ethers.getContractAt("SafeProxyFactory", SAFE_PROXY_FACTORY_141, deployer);
  const singleton = await ethers.getContractAt("Safe", SAFE_SINGLETON_141);

  const setupData = singleton.interface.encodeFunctionData("setup", [
    ownerAddrs,
    2,
    AddressZero, // no setup delegatecall
    "0x",
    AddressZero, // no fallback handler needed for this demo
    AddressZero,
    0,
    AddressZero,
  ]);

  const saltNonce = BigInt(Date.now());
  const tx = await factory.createProxyWithNonce(SAFE_SINGLETON_141, setupData, saltNonce);
  const receipt = await tx.wait();
  const created = receipt!.logs
    .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((l) => l?.name === "ProxyCreation");
  const safeAddress = created!.args[0] as string;
  const safe = await ethers.getContractAt("Safe", safeAddress, deployer);
  console.log(`Safe deployed : ${safeAddress}`);
  console.log(`  tx          : ${tx.hash}`);

  // --- fund it, so a drain attempt is a real drain attempt ---
  const fundAmount = ethers.parseEther("0.05");
  await (await deployer.sendTransaction({ to: safeAddress, value: fundAmount })).wait();
  console.log(`  funded      : ${ethers.formatEther(fundAmount)} ETH`);

  // --- install MirsadGuard. setGuard is self-authorized, so it goes through the Safe. ---
  const nonce = await safe.nonce();
  const installTx = safeTx({
    to: safeAddress,
    nonce,
    data: safe.interface.encodeFunctionData("setGuard", [guardAddress]),
  });
  const sigs = await signSafeTx(safeAddress, chainId, installTx, [owners[0], owners[1]]);
  const installed = await safe.execTransaction(...execArgs(installTx), sigs);
  await installed.wait();
  console.log(`  guard set   : ${guardAddress}`);
  console.log(`  tx          : ${installed.hash}`);

  // Safe stores the guard at a fixed slot; read it back rather than trusting the call.
  const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
  const stored = await ethers.provider.getStorage(safeAddress, GUARD_SLOT);
  const storedGuard = ethers.getAddress("0x" + stored.slice(26));
  if (storedGuard.toLowerCase() !== guardAddress.toLowerCase()) {
    throw new Error(`Guard not installed: slot holds ${storedGuard}`);
  }
  console.log(`  verified    : guard slot holds ${storedGuard}`);

  const record = {
    network: network.name,
    chainId: Number(chainId),
    deployedAt: new Date().toISOString(),
    safe: safeAddress,
    threshold: 2,
    owners: ownerAddrs,
    guard: guardAddress,
    registry: registryAddress,
  };
  const file = path.resolve(__dirname, `../deployments/${network.name}-safe.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`\nrecorded : ${path.relative(process.cwd(), file)}`);
  console.log(`\nAdd to .env:\nMIRSAD_SAFE_ADDRESS=${safeAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
