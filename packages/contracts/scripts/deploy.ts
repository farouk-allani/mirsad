import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the MIRSAD onchain layer.
 *
 * The registry's initial writer is the KeeperHub organisation wallet, because
 * that is the `msg.sender` a KeeperHub-executed write actually arrives with —
 * verified empirically on Sepolia, see CLAUDE.md §3.8c. The writer set is
 * mutable afterwards via `setWriter`, so routing changes (e.g. enabling the
 * Safe Sender toggle) never require a redeploy.
 */

/** KeeperHub org wallet — the address MIRSAD's verdict writes originate from. */
const KEEPERHUB_ORG_WALLET = "0x1F535539d5495F0e58ECB8F16006605acFfd33f4";

async function main() {
  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(deployerAddress);

  console.log(`network   : ${network.name} (chainId ${network.config.chainId})`);
  console.log(`deployer  : ${deployerAddress}`);
  console.log(`balance   : ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    throw new Error("Deployer has no ETH. Fund it before deploying.");
  }

  const writer = process.env.MIRSAD_WRITER_ADDRESS ?? KEEPERHUB_ORG_WALLET;
  console.log(`writer    : ${writer}  (initial registry writer)\n`);

  const registry = await (
    await ethers.getContractFactory("MirsadVerdictRegistry")
  ).deploy(writer);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log(`MirsadVerdictRegistry  ${registryAddress}`);

  const guard = await (
    await ethers.getContractFactory("MirsadGuard")
  ).deploy(registryAddress, deployerAddress);
  await guard.waitForDeployment();
  const guardAddress = await guard.getAddress();
  console.log(`MirsadGuard            ${guardAddress}`);

  // Fail loudly here rather than discovering it when a Safe rejects setGuard.
  const supportsGuard = await guard.supportsInterface("0xe6d7a83a");
  if (!supportsGuard) throw new Error("Guard does not advertise the Safe guard interface");

  const record = {
    network: network.name,
    chainId: Number(network.config.chainId),
    deployedAt: new Date().toISOString(),
    deployer: deployerAddress,
    contracts: {
      MirsadVerdictRegistry: registryAddress,
      MirsadGuard: guardAddress,
    },
    registryWriter: writer,
    txHashes: {
      MirsadVerdictRegistry: registry.deploymentTransaction()?.hash,
      MirsadGuard: guard.deploymentTransaction()?.hash,
    },
  };

  const dir = path.resolve(__dirname, "../deployments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");

  console.log(`\nrecorded  : ${path.relative(process.cwd(), file)}`);
  console.log("\nAdd to .env:");
  console.log(`MIRSAD_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`MIRSAD_GUARD_ADDRESS=${guardAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
