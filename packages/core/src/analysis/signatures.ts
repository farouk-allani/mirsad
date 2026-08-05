import { parseAbi, toFunctionSelector } from "viem";

/**
 * The function signatures MIRSAD cares about.
 *
 * Two families:
 *  - Safe self-administration. A transaction whose `to` is the Safe itself is
 *    changing who controls the treasury, not moving funds. These are the calls
 *    that turn a compromised signing UI into a permanent takeover.
 *  - Token allowances. An approval is a promise to let someone else move funds
 *    later, which is why drains so often look like a harmless-seeming approve.
 */

export const SAFE_ADMIN_ABI = parseAbi([
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function removeOwner(address prevOwner, address owner, uint256 _threshold)",
  "function swapOwner(address prevOwner, address oldOwner, address newOwner)",
  "function changeThreshold(uint256 _threshold)",
  "function enableModule(address module)",
  "function disableModule(address prevModule, address module)",
  "function setGuard(address guard)",
  "function setFallbackHandler(address handler)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
]);

export const PROXY_ABI = parseAbi([
  "function upgradeTo(address newImplementation)",
  "function upgradeToAndCall(address newImplementation, bytes data)",
]);

type SelectorMap = Record<`0x${string}`, string>;

function selectorsOf(abi: readonly unknown[]): SelectorMap {
  const map: SelectorMap = {};
  for (const item of abi as { type: string; name: string }[]) {
    if (item.type !== "function") continue;
    map[toFunctionSelector(item as never)] = item.name;
  }
  return map;
}

export const SAFE_ADMIN_SELECTORS = selectorsOf(SAFE_ADMIN_ABI);
export const ERC20_SELECTORS = selectorsOf(ERC20_ABI);
export const PROXY_SELECTORS = selectorsOf(PROXY_ABI);

/** `type(uint256).max` — the canonical "unlimited" allowance. */
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Allowances this large are unlimited in practice. Attackers often avoid exact
 * MAX_UINT256 precisely because naive scanners only match that one value.
 */
export const EFFECTIVELY_UNLIMITED = 2n ** 128n;
