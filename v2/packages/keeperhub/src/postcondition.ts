/**
 * Proving the position actually moved.
 *
 * A settled receipt says a transaction was mined. It does not say the supply
 * landed, that it landed for the right account, or that it landed once. Between
 * "the chain accepted this" and "the operator got what the policy authorised"
 * there is a gap that only a read closes.
 *
 * The reading is taken twice, from two places that do not share a code path:
 * KeeperHub's own Aave read action, and the aToken's `balanceOf` over plain
 * RPC. Verifying an action with the same system that performed it proves less
 * than it appears to, and a disagreement between the two is itself worth
 * knowing about.
 */

import { createPublicClient, http, parseAbi } from "viem";
import type { PublicClient } from "viem";

import type { Transport } from "./transport.js";

export interface PositionReading {
  source: "keeperhub" | "rpc";
  aTokenBalanceBaseUnits: bigint;
}

export interface PositionReader {
  read(): Promise<PositionReading>;
}

interface UserReserveData {
  success?: boolean;
  result?: { currentATokenBalance?: string };
}

/**
 * Aave's own view, through KeeperHub.
 *
 * `aave-v3/get-user-reserve-data` needs no credentials and is a read, so it
 * does not sign or broadcast despite arriving through `execute_protocol_action`.
 */
export class KeeperHubPositionReader implements PositionReader {
  constructor(
    private readonly transport: Transport,
    private readonly opts: { chainId: number; asset: string; user: string },
  ) {}

  async read(): Promise<PositionReading> {
    const response = await this.transport.callTool<UserReserveData>(
      "execute_protocol_action",
      {
        actionType: "aave-v3/get-user-reserve-data",
        params: {
          network: String(this.opts.chainId),
          asset: this.opts.asset,
          user: this.opts.user,
        },
      },
    );
    const balance = response.result?.currentATokenBalance;
    if (balance === undefined) {
      throw new Error(`no currentATokenBalance in reserve data: ${JSON.stringify(response)}`);
    }
    return { source: "keeperhub", aTokenBalanceBaseUnits: BigInt(balance) };
  }
}

const ERC20_BALANCE_OF = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
]);

/** The aToken itself, over RPC, with nothing of KeeperHub's in the path. */
export class RpcPositionReader implements PositionReader {
  private readonly client: PublicClient;

  constructor(
    private readonly opts: { rpcUrl: string; aToken: `0x${string}`; user: `0x${string}` },
  ) {
    this.client = createPublicClient({ transport: http(opts.rpcUrl) });
  }

  async read(): Promise<PositionReading> {
    const balance = await this.client.readContract({
      address: this.opts.aToken,
      abi: ERC20_BALANCE_OF,
      functionName: "balanceOf",
      args: [this.opts.user],
    });
    return { source: "rpc", aTokenBalanceBaseUnits: balance };
  }
}

export interface Postcondition {
  ok: boolean;
  /** `false` when the two independent readings disagree about the same state. */
  sourcesAgree: boolean;
  expectedIncreaseBaseUnits: string;
  observedIncreaseBaseUnits: string;
  before: PositionReading[];
  after: PositionReading[];
  message: string;
}

export interface CheckSupplyOptions {
  before: PositionReading[];
  after: PositionReading[];
  expectedIncreaseBaseUnits: string;
  /**
   * aToken balances accrue continuously, so the observed increase may exceed
   * the supply by a few units between the two reads. It may never fall short.
   */
  toleranceBaseUnits?: bigint;
}

function lowest(readings: PositionReading[]): bigint {
  return readings.reduce(
    (min, r) => (r.aTokenBalanceBaseUnits < min ? r.aTokenBalanceBaseUnits : min),
    readings[0]?.aTokenBalanceBaseUnits ?? 0n,
  );
}

function agree(readings: PositionReading[]): boolean {
  if (readings.length < 2) return true;
  const first = readings[0]?.aTokenBalanceBaseUnits;
  return readings.every((r) => r.aTokenBalanceBaseUnits === first);
}

export function checkSupplyPostcondition(options: CheckSupplyOptions): Postcondition {
  const { before, after, expectedIncreaseBaseUnits, toleranceBaseUnits = 1000n } = options;
  const expected = BigInt(expectedIncreaseBaseUnits);

  // The most conservative reading of each side, so a disagreement cannot be
  // resolved in favour of the answer we were hoping for.
  const observed = lowest(after) - lowest(before);
  const sourcesAgree = agree(before) && agree(after);

  let ok = true;
  let message = `position increased by ${observed} base units, as authorised`;

  if (observed < expected) {
    ok = false;
    message = `position increased by ${observed}, short of the ${expected} supplied`;
  } else if (observed - expected > toleranceBaseUnits) {
    ok = false;
    message = `position increased by ${observed}, more than the ${expected} supplied`;
  } else if (!sourcesAgree) {
    ok = false;
    message = "independent readings of the same position disagree";
  }

  return {
    ok,
    sourcesAgree,
    expectedIncreaseBaseUnits: expected.toString(),
    observedIncreaseBaseUnits: observed.toString(),
    before,
    after,
    message,
  };
}
