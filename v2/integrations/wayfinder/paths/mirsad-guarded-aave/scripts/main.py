"""Plan a USDC supply into Aave V3 through Wayfinder, and propose it.

This component is the planner. It reads live market state through Wayfinder's
official Aave V3 adapter and emits a proposal describing the supply it wants.

It is deliberately powerless. It holds no key, no KeeperHub credential and no
signer, it builds no calldata, and it cannot broadcast. Everything it produces
is a claim that something downstream is free to reject. The gate that reads
this proposal validates every field against a policy the operator signed, and
rebuilds the transaction itself rather than trusting anything printed here.

`--beneficiary` and `--amount` exist so that a compromised or buggy planner can
be demonstrated without editing this file. That is the point of the exercise:
the proposal is untrusted input, so proposing something outrageous has to be
possible.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from importlib.metadata import version
from typing import Any

from wayfinder_paths.adapters.aave_v3_adapter import AaveV3Adapter
from wayfinder_paths.core.config import set_rpc_urls
from wayfinder_paths.core.utils.web3 import web3_from_chain_id

# Wayfinder's Aave adapter serves mainnets only; chain 84532 is rejected as
# unsupported. Base is therefore where planning happens.
DEFAULT_CHAIN_ID = 8453
DEFAULT_RPC = {
    8453: "https://mainnet.base.org",
    84532: "https://sepolia.base.org",
}
USDC_DECIMALS = 6


def to_base_units(human: str, decimals: int = USDC_DECIMALS) -> str:
    """Exact decimal conversion. Never float: 0.1 is not 0.1 in binary."""
    scaled = Decimal(human).scaleb(decimals)
    if scaled != scaled.to_integral_value():
        raise ValueError(f"{human} is finer than {decimals} decimals")
    return str(int(scaled))


async def read_market(chain_id: int, rpc_url: str, symbol: str) -> dict[str, Any]:
    set_rpc_urls({str(chain_id): [rpc_url]})

    async with web3_from_chain_id(chain_id) as web3:
        block_number = await web3.eth.block_number

    ok, markets = await AaveV3Adapter(config={}).get_all_markets(
        chain_id=chain_id,
        include_rewards=False,
    )
    if not ok or not isinstance(markets, list):
        raise RuntimeError(f"Wayfinder Aave read failed: {markets}")

    market = next(
        (m for m in markets if str(m.get("symbol", "")).upper() == symbol.upper()),
        None,
    )
    if market is None:
        raise RuntimeError(f"{symbol} has no reserve on chain {chain_id}")
    return {"block_number": block_number, "market": market}


def build_proposal(
    chain_id: int,
    reading: dict[str, Any],
    amount_human: str,
    beneficiary: str,
) -> dict[str, Any]:
    market = reading["market"]
    return {
        "schemaVersion": "mirsad.intent.v1",
        "source": {
            "system": "wayfinder",
            "runId": os.environ.get("WAYFINDER_RUN_ID", "local"),
            "path": f"mirsad-guarded-aave@{version('wayfinder-paths')}",
        },
        "chainId": chain_id,
        "protocol": "aave-v3",
        "action": "supply",
        "target": market["pool"],
        "token": market["underlying"],
        "amountBaseUnits": to_base_units(amount_human, int(market["decimals"])),
        "beneficiary": beneficiary,
        "observations": {
            "blockNumber": str(reading["block_number"]),
            "observedAt": datetime.now(timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z"),
        },
    }


def rationale(reading: dict[str, Any]) -> dict[str, Any]:
    """Why the planner wants to act. Context for a human, never for the gate."""
    market = reading["market"]
    return {
        "symbol": market["symbol"],
        "supplyApy": market["supply_apy"],
        "availableLiquidityTokens": market["available_liquidity_tokens"],
        "isActive": market["is_active"],
        "isFrozen": market["is_frozen"],
        "isPaused": market["is_paused"],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chain-id", type=int, default=DEFAULT_CHAIN_ID)
    parser.add_argument("--rpc-url", default=None)
    parser.add_argument("--symbol", default="USDC")
    parser.add_argument("--amount", default="1", help="human units, e.g. 1 or 0.5")
    parser.add_argument(
        "--beneficiary",
        default=os.environ.get("MIRSAD_ACTOR", ""),
        help="who receives the position; override to model a compromised planner",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.beneficiary:
        raise SystemExit("set --beneficiary or MIRSAD_ACTOR")

    rpc_url = args.rpc_url or DEFAULT_RPC.get(args.chain_id)
    if not rpc_url:
        raise SystemExit(f"no default RPC for chain {args.chain_id}; pass --rpc-url")

    reading = asyncio.run(read_market(args.chain_id, rpc_url, args.symbol))
    print(
        json.dumps(
            {
                "proposal": build_proposal(
                    args.chain_id, reading, args.amount, args.beneficiary
                ),
                "rationale": rationale(reading),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
