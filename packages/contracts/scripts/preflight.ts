import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Answers one question before you press record: is the queue staged correctly?
 *
 * The failure this prevents is specific and expensive. Verdicts are write-once,
 * so running the watch loop once more "just to check" silently vetoes the
 * transaction you meant to catch on camera — and the take then shows
 * "already vetoed onchain" instead of a live veto, which is the whole demo.
 *
 *   pnpm hardhat run scripts/preflight.ts --network sepolia
 */

const SHORTNAMES: Record<string, string> = { "11155111": "sep", "1": "eth", "8453": "base" };

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const shortname = SHORTNAMES[chainId.toString()]!;
  const record = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../deployments/${network.name}-safe.json`), "utf8"),
  );

  const registryAddress = process.env.MIRSAD_REGISTRY_ADDRESS;
  if (!registryAddress) throw new Error("MIRSAD_REGISTRY_ADDRESS not set");
  const registry = await ethers.getContractAt("MirsadVerdictRegistry", registryAddress);

  const res = await fetch(
    `https://api.safe.global/tx-service/${shortname}/api/v1/safes/${record.safe}` +
      `/multisig-transactions/?executed=false&limit=50`,
    { headers: process.env.SAFE_API_KEY ? { Authorization: `Bearer ${process.env.SAFE_API_KEY}` } : {} },
  );
  const queue = (await res.json()) as { results: { safeTxHash: string; to: string }[] };

  console.log(`safe    : ${record.safe}`);
  console.log(`balance : ${ethers.formatEther(await ethers.provider.getBalance(record.safe))} ETH\n`);

  const unvetoed: string[] = [];
  for (const t of queue.results) {
    const vetoed = await registry.isVetoed(t.safeTxHash);
    if (!vetoed) unvetoed.push(t.safeTxHash);
    console.log(
      `  ${t.safeTxHash.slice(0, 14)}…  ${vetoed ? "vetoed" : "NOT VETOED  <-- the one you catch on camera"}`,
    );
  }

  const queued = queue.results.length;
  console.log("");

  if (queued === 0) {
    console.log("NOT READY: the queue is empty. Stage it — see docs/DEMO.md.");
    process.exitCode = 1;
  } else if (unvetoed.length === 0) {
    console.log(
      "NOT READY: everything queued is already vetoed, so the watch loop will\n" +
        "write nothing on camera. Queue one unused scenario:\n" +
        "  SCENARIO=<drain|delegatecall|owner-swap|guard-removal> pnpm hardhat run scripts/queue-attack.ts --network sepolia",
    );
    process.exitCode = 1;
  } else if (unvetoed.length > 1) {
    console.log(
      `NOT READY: ${unvetoed.length} transactions are unvetoed. The watch loop will veto\n` +
        "all of them at once, which muddles the shot. Run the loop once to clear\n" +
        "the extras, then queue exactly one fresh scenario.",
    );
    process.exitCode = 1;
  } else {
    console.log(`READY. ${queued} queued, ${queued - 1} already vetoed, 1 waiting.\n`);
    console.log(`Shot 5 command:\n  SAFE_TX_HASH=${unvetoed[0]} pnpm hardhat run scripts/attempt-execute.ts --network sepolia\n`);
    console.log("Do NOT run `pnpm run watch` again until the camera is rolling.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
