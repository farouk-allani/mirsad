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

## Still to come

Items below get filled in as they happen — key creation, first `execute_transfer`, Safe deployment, marketplace listing, x402 settlement, gas sponsorship.

- [ ] Account signup → first `kh_` key
- [ ] `kh` installed and authenticated on Windows
- [ ] First landed transaction (Sepolia)
- [ ] Safe deployed and linked
- [ ] `Get Pending Transactions` returning real queue data
- [ ] Marketplace listing + first paid x402 call
- [ ] Mainnet gas sponsorship
