import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { safeTx, signSafeTx, execArgs, Operation } from "../lib/safeTx";

/**
 * Plays the attacker: proposes a malicious transaction to the Safe Transaction
 * Service so it appears in the real pending queue, exactly as a compromised
 * signing UI or a phished proposer would.
 *
 * Nothing here is privileged. Proposing only requires one owner signature —
 * which is the entire point. The queue is a place anyone with one key can put
 * something that looks routine, and the other owners are expected to catch it
 * by reading hex in a browser. That is the gap MIRSAD closes.
 *
 *   pnpm hardhat run scripts/queue-attack.ts --network sepolia
 *   SCENARIO=owner-swap pnpm hardhat run scripts/queue-attack.ts --network sepolia
 *
 * Scenario comes from the environment because Hardhat 2 rejects positional
 * arguments after the script path (HH308).
 */

const SHORTNAMES: Record<string, string> = { "11155111": "sep", "1": "eth", "8453": "base" };

type Scenario = "drain" | "delegatecall" | "owner-swap" | "guard-removal";

function pickScenario(): Scenario {
  const valid: Scenario[] = ["drain", "delegatecall", "owner-swap", "guard-removal"];
  const requested = process.env.SCENARIO?.trim();
  if (requested && !valid.includes(requested as Scenario)) {
    throw new Error(`Unknown SCENARIO "${requested}". Expected one of: ${valid.join(", ")}`);
  }
  return (requested as Scenario) ?? "drain";
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const shortname = SHORTNAMES[chainId.toString()];
  if (!shortname) throw new Error(`No Safe Transaction Service shortname for chain ${chainId}`);

  const record = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, `../deployments/${network.name}-safe.json`), "utf8"),
  );
  const safe = await ethers.getContractAt("Safe", record.safe);
  const mnemonic = process.env.DEMO_SAFE_MNEMONIC;
  if (!mnemonic) throw new Error("DEMO_SAFE_MNEMONIC not set");

  // The compromised proposer. One key is all an attacker needs to fill the queue.
  const proposer = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/0`);

  const scenario = pickScenario();
  const nonce = await safe.nonce();
  const attacker = "0x000000000000000000000000000000000000dEaD";

  let tx;
  let statedIntent: string;

  switch (scenario) {
    case "delegatecall":
      tx = safeTx({ to: attacker, nonce, data: "0xdeadbeef", operation: Operation.DelegateCall });
      statedIntent = "Approve the quarterly treasury rebalance as discussed on the ops call.";
      break;
    case "owner-swap":
      tx = safeTx({
        to: record.safe,
        nonce,
        data: safe.interface.encodeFunctionData("swapOwner", [
          "0x0000000000000000000000000000000000000001",
          record.owners[2],
          attacker,
        ]),
      });
      statedIntent = "Rotate the hardware wallet for owner 3, per our key-rotation policy.";
      break;
    case "guard-removal":
      tx = safeTx({
        to: record.safe,
        nonce,
        data: safe.interface.encodeFunctionData("setGuard", [ethers.ZeroAddress]),
      });
      statedIntent = "Routine maintenance: clear a deprecated module reference.";
      break;
    default:
      tx = safeTx({ to: attacker, nonce, value: ethers.parseEther("0.04") });
      statedIntent = "Monthly vendor payment to our infrastructure provider.";
  }

  const safeTxHash = await safe.getTransactionHash(...execArgs(tx), nonce);
  const signature = await signSafeTx(record.safe, chainId, tx, [proposer]);

  const body = {
    to: tx.to,
    value: tx.value.toString(),
    data: tx.data === "0x" ? null : tx.data,
    operation: tx.operation,
    baseGas: tx.baseGas.toString(),
    gasPrice: tx.gasPrice.toString(),
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    safeTxGas: tx.safeTxGas.toString(),
    nonce: Number(tx.nonce),
    contractTransactionHash: safeTxHash,
    sender: proposer.address,
    signature,
    origin: JSON.stringify({ name: "MIRSAD demo", scenario, statedIntent }),
  };

  const url = `https://api.safe.global/tx-service/${shortname}/api/v1/safes/${record.safe}/multisig-transactions/`;
  const apiKey = process.env.SAFE_API_KEY;

  console.log(`scenario   : ${scenario}`);
  console.log(`safe       : ${record.safe}`);
  console.log(`nonce      : ${nonce}`);
  console.log(`safeTxHash : ${safeTxHash}`);
  console.log(`proposer   : ${proposer.address}`);
  console.log(`claim      : "${statedIntent}"\n`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (res.status === 201 || res.status === 200 || res.status === 204) {
    console.log(`queued. It is now sitting in the Safe's pending queue awaiting signatures.`);
    console.log(`https://app.safe.global/transactions/queue?safe=${shortname}:${record.safe}`);
  } else {
    console.error(`propose failed: HTTP ${res.status}`);
    console.error(await res.text());
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
