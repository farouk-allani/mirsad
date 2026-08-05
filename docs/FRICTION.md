# FRICTION.md — a teardown of zero-to-first-transaction on KeeperHub

**Builder:** MIRSAD team · **Platform:** Windows 11 Pro, PowerShell, node 22.17, pnpm 10.14
**Started:** 2026-08-05 · **Method:** every item written the moment it happened, not reconstructed afterwards.

This is a bounty submission for *Best Onboarding UX Improvement*. It is ordered by **cost to a new builder**, and every item ends with a concrete proposed fix rather than a complaint. Items marked 🔧 have a patch or PR attached.

---

## Legend

| Cost | Meaning |
|---|---|
| 🔴 **Blocker** | New builder stops here and asks in Discord, or gives up. |
| 🟠 **Detour** | Costs 15–60 min of guessing. |
| 🟡 **Papercut** | Costs a few minutes or a moment of doubt. |

---

## 1. 🔴 There is no Windows install path for the `kh` CLI

**What happened.** `docs.keeperhub.com/cli` offers exactly three install methods:

```
brew install keeperhub/tap/kh
go install github.com/keeperhub/cli/cmd/kh@latest
# or download a binary from GitHub Releases
```

On a clean Windows 11 box, the first two are unavailable — no Homebrew, no Go toolchain. The third is technically correct but tells the builder nothing: which asset name, where to put it, how to get it on `PATH`, whether PowerShell's execution policy or SmartScreen will object. A Windows builder's first interaction with KeeperHub is a guessing game, and Windows is not a rare developer platform.

**Why it costs more than it looks.** The CLI is how the docs' own quickstart expects you to land your first transaction. Blocking it blocks the hard gate of the entire hackathon.

**Proposed fix.**
1. Add a **Windows** tab to the install section with a copy-pasteable one-liner, e.g.
   ```powershell
   irm https://get.keeperhub.com/install.ps1 | iex
   ```
   mirroring the `curl | sh` convention already common for Go CLIs.
2. Failing that, publish to **Scoop** and/or **winget** — both are near-zero maintenance for a Go binary that already has GitHub Releases artifacts, and `goreleaser` (almost certainly already in use for the tap) emits both manifests from config.
3. At minimum: name the exact release asset for `windows/amd64` and show the two PowerShell lines to place it on `PATH`.

*Status: open. Candidate PR to `KeeperHub/cli` + docs.*

---

## 2. 🟠 The Safe plugin's chain support is inconsistent *between actions*, and the docs do not warn you

**What happened.** Building on Sepolia, the natural first workflow is: read the Safe's pending queue, then read its owners and nonce to reason about the transactions. `Get Pending Transactions` supports Sepolia and Base Sepolia. But the on-chain read actions — `Get Owners`, `Get Threshold`, `Is Owner`, `Get Nonce`, `Is Module Enabled`, `Get Modules Paginated` — support only **Ethereum, Base, Arbitrum, Optimism**. All mainnets.

So on the testnet the docs themselves recommend for hackathons, half the Safe plugin works and half does not, and the two halves are documented in the same table without the discrepancy being called out.

**Why it costs more than it looks.** The failure arrives at runtime, after the builder has designed a workflow around actions they reasonably assumed were uniform. Debugging points at your Safe address or your network config long before it points at the plugin's chain list.

**Proposed fix.**
1. **The real fix:** add Sepolia and Base Sepolia to the on-chain read actions. These are plain `eth_call`s against canonical Safe addresses — Safe v1.4.1 is deployed on both — so this should be a chain-list addition, not new logic.
2. **Immediate docs fix:** put a per-action chain column in the plugin table, and a callout: *"On-chain reads and Get Pending Transactions support different chain sets."*
3. **Error-message fix:** when an action is invoked on an unsupported chain, say so explicitly — `Safe read actions are not available on chain 11155111 (supported: 1, 8453, 42161, 10)` — rather than failing as a generic call error.

*Status: open. Strongest merge candidate. Repo: `KeeperHub/keeperhub`.*

---

## 3. 🟡 Two API key systems, two prefixes, two endpoints, one word

**What happened.** KeeperHub has `kh_` (organization; REST, MCP, CLI, plugin; managed at `/api/keys`) and `wfb_` (user; webhook trigger auth only; managed at `/api/api-keys`). Both are called "API keys." The management endpoints differ by a single hyphen.

**Proposed fix.** Rename the user-scoped one in the UI and docs to **"Webhook key"** — it has exactly one job. Keep `wfb_`. If the paths must stay, make the settings pages cross-link with one line each: *"Looking for webhook trigger keys? They're here."*

---

## 4. 🟡 `simulate` silently means something different as a string

**What happened.** The docs are careful to say `"simulate": true` must be a JSON boolean, *not* a string. That the warning needs to exist at all suggests the failure mode is common — and a string `"true"` is exactly what a shell-driven or template-driven call produces.

**Proposed fix.** Coerce it, or reject it loudly. Accepting `"true"` as truthy is fine; silently treating it as *not simulating* and broadcasting a live transaction is the worst possible default in an execution layer. If coercion is undesirable, return a 400 naming the field and the received type. Given the product is "the reliability layer," failing closed here is on-brand.

---

## 5. 🟡 `/wallet-management/safe-smart-accounts` 404s; the page is at `/wallet-management/safe`

**What happened.** The sidebar label is "Safe Smart Accounts," which makes the slug look guessable. It is not, and the 404 gives no suggestion.

**Proposed fix.** Add a redirect from the label-derived slug, and turn the docs 404 into a search-suggestion page. Cheap, and it catches every future label/slug drift, not just this one.

---

## 6. 🟠 `/api/chains` returns two different things both called an id

**What happened.** Every chain object carries an internal `id` (a nanoid, `8wwunraqp7z0901rirvbo`) *and* a `chainId` (the numeric EVM chain id, `11155111`). The quickstart tells you to pass `chain_id` as a string, so `id` looks like the field you want. Filtering or matching on it silently returns nothing — no error, just an empty result you then debug as a network or auth problem.

**Proposed fix.** Rename the internal identifier to `keeperhubChainId` (or omit it from the public response entirely — callers address chains by EVM id everywhere else in the product). If it must stay, add one line to the API reference: *"`id` is KeeperHub's internal record id. Use `chainId` for `chain_id` in execution calls."*

---

## 7. 🟡 REST path discovery is trial-and-error

**What happened.** Looking for the org wallet's balance, these all 404: `/api/wallet`, `/api/wallets`, `/api/wallet/info`, `/api/wallet/tokens`, `/api/billing/status`, `/api/executions`, `/api/analytics` — despite `kh wallet balance`, `kh billing status`, and an Analytics section all existing in the docs. The working set turned out to be `/api/workflows`, `/api/keys`, `/api/chains`, `/api/integrations`, `/api/integrations/{id}`.

**Why it costs more than it looks.** The CLI command list reads like an API surface map, so a builder reasonably infers `kh wallet balance` → `GET /api/wallet/balance`. It isn't, and nothing says so.

**Proposed fix.** Publish the OpenAPI document at a discoverable path and link it from the API reference index — `/openapi.json` is already referenced in the agentic-wallet docs for meta-tools, so most of this likely exists already. A one-line "the CLI is not a 1:1 mirror of the REST API" note in the CLI reference would also cover it.

---

## 8. 🟠 `simulate` reports gas for a path the execution doesn't take

**What happened.** Landing our first transfer on Sepolia, the documented safe-write sequence returned:

| Step | `gasEstimate` / `gasUsed` |
|---|---|
| `simulate: true` preflight | `21000` |
| actual receipt | `74793` |

3.6× off. The cause is legitimate: the transaction was **gas-sponsored**, so it executed as a meta-transaction — relayer `0xa17c…4e87` calling forwarder `0x5af5…f07d` with `value: 0` and 522 bytes of calldata — while the simulation modeled a bare EOA transfer (`21000` is *exactly* the base cost of one, which is the tell).

**Why it costs more than it looks.** "Smart Gas Estimation" is a headline feature, and preflight gas is what a builder budgets against — for funding decisions, for cost alerts, for deciding whether a batch is affordable. Silently estimating a path the executor won't take undercuts the feature where it's most load-bearing. The discrepancy is also invisible unless you diff the two numbers yourself; nothing in the response flags it.

**Proposed fix.** Have the simulation reflect the route the executor will actually take: if the org is sponsorship-eligible on that chain, simulate the forwarder path. Failing that, return the route in the preflight response — `"route": "sponsored-forwarder"` alongside `gasEstimate` — so a caller can at least tell the estimate is for a different path. Cheapest interim fix: one sentence in the safe-write docs noting that `gasEstimate` reflects the direct path and sponsored execution will exceed it.

---

## 9. 🟡 Gas sponsorship is documented as mainnet-only but works on Sepolia

**What happened.** The hackathon brief and docs say gas sponsorship is offered "on mainnet Ethereum." Our first Sepolia transfer came back `"sponsored": true`, and the wallet's balance was **0.15 ETH before and 0.15 ETH after** — fully covered.

This is a *good* surprise, but it's still friction: we told the builder to fund a wallet from a faucet before their first write, and it turned out to be unnecessary. A builder blocked on a dry faucet might give up on the hard gate of the whole hackathon without ever discovering that sponsorship would have carried them.

**Proposed fix.** Say where sponsorship applies, per chain — ideally as a field on `/api/chains` (`gasSponsorship: true|false`) so it's discoverable programmatically rather than only from a receipt after the fact. Update the docs line to name the testnets. For the hackathon specifically, this is worth saying loudly in the quickstart: *"you may not need testnet ETH at all."*

---

## Still to come

Items below get filled in as they happen — key creation, first `execute_transfer`, Safe deployment, marketplace listing, x402 settlement, gas sponsorship.

- [x] Account signup → first `kh_` key
- [ ] `kh` installed and authenticated on Windows
- [x] First landed transaction (Sepolia) — [`0xb6afb213…`](https://sepolia.etherscan.io/tx/0xb6afb2133ed33b7a7192fbddfad9bd7761f329e5b4c0e46c184105082aeb50a4), via MCP, gas-sponsored
- [ ] Safe deployed and linked
- [ ] `Get Pending Transactions` returning real queue data
- [ ] Marketplace listing + first paid x402 call
- [ ] Mainnet gas sponsorship
