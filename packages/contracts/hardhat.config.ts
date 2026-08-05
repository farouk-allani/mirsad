import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
import * as path from "path";
import type { HardhatUserConfig } from "hardhat/config";

// Contracts share the repo-root .env with the agent — one place for the
// KeeperHub key, the chain id, and the deployed addresses.
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Safe 1.4.1 targets a pre-Cancun EVM; London keeps the guard
      // deployable on every chain KeeperHub supports.
      evmVersion: "london",
    },
  },
  networks: {
    hardhat: {},
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      // Deployment key is separate from the KeeperHub org wallet, whose key
      // KeeperHub custodies via Turnkey and we never see.
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // A single key, not a per-network map: the per-network form is the
    // Etherscan V1 shape and V1 endpoints are retired.
    apiKey: process.env.ETHERSCAN_API_KEY ?? "",
  },
  sourcify: { enabled: false },
};

export default config;
