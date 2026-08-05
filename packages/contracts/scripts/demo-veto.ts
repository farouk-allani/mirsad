import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { safeTx, signSafeTx, execArgs, Level, Operation } from "../lib/safeTx";
import { KeeperHub } from "../lib/keeperhub";

/**
 * The demo, end to end, on a live chain.
 *
 *   1. An attacker queues a drain on the treasury's Safe.
 *   2. MIRSAD assesses it and writes a VETO onchain -- through KeeperHub.
 *   3. All THREE owners sign it. The Safe needs only two.
 *   4. The transaction reverts anyway.
 *
 * Step 4 is the product. Everything else is setup.
 */

const REGISTRY_ABI = JSON.stringify([
  {
    inputs: [
      { internalType: "bytes32", name: "safeTxHash", type: "bytes32" },
      { internalType: "uint8", name: "level", type: "uint8" },
      { internalType: "bytes32", name: "reasonHash", type: "bytes32" },
    ],
    name: "setVerdict",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
]);

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

async function main() {
  const [submitter] = await ethers.getSigners();
  const chainId = (await ethers.provider.getNetwork()).chainId;

  const safeRecord = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../deployments/${network.name}-safe.json`), "utf8"),
  );
  const safe = await ethers.getContractAt("Safe", safeRecord.safe, submitter);
  const owners = [0, 1, 2].map((i) =>
    ethers.HDNodeWallet.fromPhrase(required("DEMO_SAFE_MNEMONIC"), undefined, `m/44'/60'/0'/0/${i}`),
  );

  const attacker = "0x000000000000000000000000000000000000dEaD";
  const drainAmount = ethers.parseEther("0.04");

  console.log(`Safe      : ${safeRecord.safe}`);
  console.log(`threshold : ${safeRecord.threshold} of ${safeRecord.owners.length}`);
  console.log(`balance   : ${ethers.formatEther(await ethers.provider.getBalance(safeRecord.safe))} ETH\n`);

  // --- 1. the attack, queued ---
  const nonce = await safe.nonce();
  const drain = safeTx({ to: attacker, value: drainAmount, nonce, operation: Operation.Call });
  const safeTxHash = await safe.getTransactionHash(...execArgs(drain), nonce);
  console.log(`[1] attacker queues a drain of ${ethers.formatEther(drainAmount)} ETH to ${attacker}`);
  console.log(`    safeTxHash ${safeTxHash}\n`);

  // --- 2. MIRSAD's verdict, written onchain through KeeperHub ---
  // The reason hash commits to the findings so the audit trail is verifiable
  // offchain without paying to store prose onchain.
  const findings = JSON.stringify({
    safeTxHash,
    findings: [
      { code: "unknown-recipient", severity: "VETO", source: "rule",
        summary: "Recipient is not in the treasury address book." },
      { code: "value-drift", severity: "VETO", source: "rule",
        summary: "Transfers 80% of the Safe balance; proposal described a routine payment." },
    ],
    verdict: "VETO",
  });
  const reasonHash = ethers.keccak256(ethers.toUtf8Bytes(findings));

  console.log(`[2] MIRSAD verdict: VETO`);
  console.log(`    reasonHash ${reasonHash}`);
  console.log(`    writing onchain via KeeperHub...`);

  const kh = new KeeperHub(required("KEEPERHUB_API_KEY"));
  await kh.connect();
  const result = await kh.writeContract({
    chainId: chainId.toString(),
    contractAddress: required("MIRSAD_REGISTRY_ADDRESS"),
    functionName: "setVerdict",
    functionArgs: [safeTxHash, Level.Veto, reasonHash],
    abi: REGISTRY_ABI,
    idempotencyKey: `mirsad-veto-${safeTxHash.slice(2, 18)}`,
  });
  console.log(`    ${result.status}  gas ${result.gasUsedWei}  sponsored=${result.sponsored}`);
  console.log(`    ${result.transactionLink}\n`);

  const registry = await ethers.getContractAt(
    "MirsadVerdictRegistry",
    required("MIRSAD_REGISTRY_ADDRESS"),
  );
  console.log(`[3] registry.isVetoed(safeTxHash) = ${await registry.isVetoed(safeTxHash)}\n`);

  // --- 4. every owner signs. it still fails. ---
  console.log(`[4] all ${owners.length} owners sign (threshold is ${safeRecord.threshold})...`);
  const sigs = await signSafeTx(safeRecord.safe, chainId, drain, owners);
  const balanceBefore = await ethers.provider.getBalance(safeRecord.safe);

  try {
    const tx = await safe.execTransaction(...execArgs(drain), sigs);
    await tx.wait();
    console.error(`\n    !! DRAIN SUCCEEDED -- the guard did not hold. ${tx.hash}`);
    process.exitCode = 1;
    return;
  } catch (err: any) {
    const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
    let decoded = "";
    if (typeof data === "string" && data.startsWith("0x")) {
      try {
        const guard = await ethers.getContractAt("MirsadGuard", required("MIRSAD_GUARD_ADDRESS"));
        const parsed = guard.interface.parseError(data);
        if (parsed) decoded = `${parsed.name}(${parsed.args.join(", ")})`;
      } catch { /* fall through to raw reason */ }
    }
    console.log(`    REVERTED: ${decoded || err.shortMessage || err.message}`);
  }

  const balanceAfter = await ethers.provider.getBalance(safeRecord.safe);
  console.log(`\n    balance before : ${ethers.formatEther(balanceBefore)} ETH`);
  console.log(`    balance after  : ${ethers.formatEther(balanceAfter)} ETH`);
  console.log(
    balanceBefore === balanceAfter
      ? `\n    The treasury did not move. Three signatures were not enough.`
      : `\n    !! balance changed`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
