import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { safeTx, signSafeTx, execArgs, Operation } from "../lib/safeTx";

/**
 * Plays the treasury: signs a queued transaction with EVERY owner and tries to
 * execute it.
 *
 * This is the other half of the demo. `mirsad watch` shows the agent deciding;
 * this shows what that decision is worth. It deliberately over-signs — every
 * owner, not just the threshold — so that a revert cannot be explained away as
 * a missing signature.
 *
 *   pnpm hardhat run scripts/attempt-execute.ts --network sepolia
 */

const SHORTNAMES: Record<string, string> = { "11155111": "sep", "1": "eth", "8453": "base" };

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const shortname = SHORTNAMES[chainId.toString()]!;
  const record = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../deployments/${network.name}-safe.json`), "utf8"),
  );

  const [submitter] = await ethers.getSigners();
  const safe = await ethers.getContractAt("Safe", record.safe, submitter);
  const owners = [0, 1, 2].map((i) =>
    ethers.HDNodeWallet.fromPhrase(process.env.DEMO_SAFE_MNEMONIC!, undefined, `m/44'/60'/0'/0/${i}`),
  );

  // Take the oldest pending entry, as a treasury working its queue would.
  const res = await fetch(
    `https://api.safe.global/tx-service/${shortname}/api/v1/safes/${record.safe}` +
      `/multisig-transactions/?executed=false&limit=20&ordering=nonce`,
    { headers: process.env.SAFE_API_KEY ? { Authorization: `Bearer ${process.env.SAFE_API_KEY}` } : {} },
  );
  const queue = (await res.json()) as { results: any[] };
  const nonce = await safe.nonce();
  const executable = queue.results.filter((t) => Number(t.nonce) === Number(nonce));

  // Every queued transaction competes for the same nonce, so a queue with
  // several attacks in it has several candidates. SAFE_TX_HASH pins the one you
  // mean — without it a demo can veto one transaction on camera and then try to
  // execute a different one.
  const wanted = process.env.SAFE_TX_HASH?.trim().toLowerCase();
  const entry = wanted
    ? executable.find((t) => String(t.safeTxHash).toLowerCase() === wanted)
    : executable[0];

  if (!entry) {
    console.log(
      wanted
        ? `SAFE_TX_HASH ${wanted} is not executable at nonce ${nonce}.`
        : `nothing executable at nonce ${nonce}. Queue an attack first.`,
    );
    if (executable.length > 1) {
      console.log(`\n${executable.length} transactions compete for nonce ${nonce}:`);
      for (const t of executable) console.log(`  ${t.safeTxHash}  -> ${t.to}`);
      console.log(`\nPin one with SAFE_TX_HASH=0x...`);
    }
    return;
  }

  if (!wanted && executable.length > 1) {
    console.log(`note: ${executable.length} transactions share nonce ${nonce}; ` +
      `executing the first. Set SAFE_TX_HASH to pin a specific one.\n`);
  }

  const tx = safeTx({
    to: entry.to,
    value: BigInt(entry.value ?? "0"),
    data: entry.data ?? "0x",
    operation: Number(entry.operation) === 1 ? Operation.DelegateCall : Operation.Call,
    nonce: BigInt(entry.nonce),
  });

  const balanceBefore = await ethers.provider.getBalance(record.safe);
  console.log(`Safe      : ${record.safe}`);
  console.log(`balance   : ${ethers.formatEther(balanceBefore)} ETH`);
  console.log(`executing : nonce ${entry.nonce} -> ${entry.to}`);
  console.log(`            ${entry.safeTxHash}`);
  console.log(`\nsigning with all ${owners.length} owners (threshold is ${record.threshold})...`);

  const sigs = await signSafeTx(record.safe, chainId, tx, owners);

  try {
    const sent = await safe.execTransaction(...execArgs(tx), sigs);
    await sent.wait();
    console.log(`\n  EXECUTED. ${sent.hash}`);
    console.log(`  balance after: ${ethers.formatEther(await ethers.provider.getBalance(record.safe))} ETH`);
  } catch (err: any) {
    const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
    let decoded = "";
    if (typeof data === "string" && data.startsWith("0x")) {
      try {
        const guard = await ethers.getContractAt("MirsadGuard", process.env.MIRSAD_GUARD_ADDRESS!);
        const parsed = guard.interface.parseError(data);
        if (parsed) decoded = `${parsed.name}(${parsed.args.join(", ")})`;
      } catch { /* fall through */ }
    }
    console.log(`\n  REVERTED: ${decoded || err.shortMessage || err.message}`);
    const after = await ethers.provider.getBalance(record.safe);
    console.log(`\n  balance before : ${ethers.formatEther(balanceBefore)} ETH`);
    console.log(`  balance after  : ${ethers.formatEther(after)} ETH`);
    console.log(
      balanceBefore === after
        ? `\n  The treasury did not move. Every owner signed and it was not enough.`
        : `\n  balance changed`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
