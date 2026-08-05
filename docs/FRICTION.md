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

## 10. 🔴 The documented `execute_contract_call` parameters are not the ones the server accepts

**What happened.** `execute_contract_call` is the primary write path — it is how an agent does anything onchain beyond a plain transfer. The MCP docs page gives its parameters as:

```
execute_contract_call(chain_id, contractAddress, abi, function, args, simulate, idempotency_key)
```

The server's own `inputSchema`, read from `tools/list`, is:

```
execute_contract_call(chain_id, contract_address, function_name, function_args,
                      abi, value, gas_limit_multiplier, priority_fee_gwei,
                      simulate, idempotency_key)
required: contract_address, chain_id, function_name
```

Three of the documented names are wrong, and the types differ:

| Docs | Server | Note |
|---|---|---|
| `contractAddress` | `contract_address` | camelCase vs snake_case |
| `function` | `function_name` | |
| `args` (array) | `function_args` | **a JSON *string***, e.g. `"[\"0x…\",\"1000\"]"`, not an array |
| — | `value` | undocumented; needed for any payable function |
| — | `gas_limit_multiplier` | undocumented |
| — | `priority_fee_gwei` | undocumented; bypasses the chain's priority-fee clamp |

**Why it costs more than it looks.** A builder copying the documented call gets a validation error on the one tool that matters most, and the natural reading of that error is "my ABI or my address is wrong" — not "the parameter names in the docs are wrong." The undocumented parameters are worse in the other direction: `priority_fee_gwei` is exactly the escape hatch you need when a transaction is stuck behind a priority-fee floor, which is the flagship failure mode this product exists to solve, and it is not mentioned anywhere a builder would look.

**Proposed fix.** Generate the docs page from the server's `inputSchema` rather than maintaining it by hand — the schema already carries good per-field descriptions, so the generated page would be strictly better than the current one and cannot drift again. Short term, correct the three names and document `value`, `gas_limit_multiplier`, and `priority_fee_gwei`.

*Status: open. Strongest merge candidate — it breaks the primary write path. Repo: docs + `KeeperHub/keeperhub`.*

---

## 10b. 🔴 The same drift affects at least four more tools — this is systemic

Item 10 is not an isolated typo. Every MCP tool we reached for had a documented signature that the server rejected:

| Tool | Docs say | Server requires |
|---|---|---|
| `execute_contract_call` | `contractAddress`, `function`, `args` | `contract_address`, `function_name`, `function_args` |
| `get_wallet_integration` | *(no parameters)* | `integrationId` |
| `get_plugin` | `type` | `pluginType` |
| `validate_workflow` | `nodes`, `edges` | `workflowId`, `deepCheck` |
| `list_workflow` | `id`, `description`, `tags`, `category` | `workflowId`, `slug`, `category`, `chain`, `inputSchema`, `outputMapping`, `workflowType` |

Five of the tools a builder needs first, all wrong in the same direction: hand-written docs that fell behind a generated schema. `validate_workflow` is the sharpest case — the docs describe validating a *draft* graph before creating it, while the server only validates an *already-created* workflow by id. Those are different features, so a builder doesn't experience it as a parameter-name error at all; they conclude they've misunderstood the product.

**This one fix retires items 10, 11, and this one at once:** generate the MCP docs page from `tools/list`. Every field already carries a good description in the schema — several are *better* than the prose docs (`priority_fee_gwei` explains exactly when to reach for it, and appears nowhere in the docs). The generated page would be more accurate and more complete than what is published today, and it cannot drift again.

**Workaround for other builders in the meantime:** call `tools/list` and read `inputSchema`. It is authoritative, and it takes one request:

```bash
curl -s https://app.keeperhub.com/mcp -H "Authorization: Bearer kh_..." \
  -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[] | {name, inputSchema}'
```

---

## 11. 🟡 `get_wallet_integration` is documented as taking no parameters; it requires one

Docs list it under "(no parameters)". The server's schema is `{integrationId: string}`, `required: ["integrationId"]` — calling it as documented returns `MCP error -32602`. Same root cause as #10, same fix: generate from schema. (Get the id from `/api/integrations` or `list_integrations`.)

---

## 12. 🟡 Sibling execution tools return different response shapes

`execute_transfer` returns `executionId`, `status`, `transactionHash`, and `transactionLink` inline. `execute_contract_call` returns only `executionId` and `status` — you must call `get_direct_execution_status` to get the hash, even when the call has already completed.

**Why it matters.** The documented safe-write sequence ends "retain `transactionLink` as onchain proof," which implies the write returns one. For half the write surface it doesn't, and a client that reads `transactionHash` off the response gets `undefined` with no error — it looks like the transaction silently failed.

**Proposed fix.** Return the same envelope from both tools. If the hash genuinely isn't known yet, say so explicitly (`"transactionHash": null, "poll": true`) rather than omitting the field.

---

## 13. 🔴 The Code action is Pro-only, and nothing says so until you publish

**What happened.** The marketplace is a headline feature of both the product and this hackathon — "go from consumer of KeeperHub to supplier on it." We built a listing that reads a Safe's pending queue and runs security detectors over it in a `code/run-code` node, then published it:

```json
402 Payment Required
{"error":"This workflow uses features that require a paid plan.","code":"upgrade_required",
 "violations":[{"featureId":"action.code","featureName":"Code action",
                "requiredPlan":"pro","actionType":"code/run-code","nodeIds":["step-2"]}]}
```

The failure arrives at `create_workflow`, after the node graph is written, the detector logic is ported into sandboxed JS, and the input/output schemas are designed around it.

**Why it costs more than it looks.** Nothing upstream signals the gate:

- `get_plugin` with `pluginType: "code"` returns the full action schema — `requiredFields`, `optionalFields`, `outputFields` — with **no plan field and no mention of a tier**. It reads exactly like the free Safe and Web3 actions next to it.
- The plugin index lists Code alongside Math, Webhook, and Web3 with no tier marking.
- `validate_workflow` is not reachable as a pre-check, because validation requires an *already-created* workflow (see #10b) — and creation is what fails.

So the only way to discover the gate is to hit it. For a hackathon where the marketplace is explicitly one of the judged surfaces, that is a lot of work to lose. The Code action is also the natural way to do anything non-trivial in a listing: without it, a workflow can read chain state and branch on a condition, but it cannot transform, aggregate, or score anything — which is most of what a paid service would sell.

**Proposed fix, cheapest first.**
1. Add `requiredPlan` to the action schema returned by `get_plugin` and `list_action_schemas`. One field, and it makes every client — including agents, which cannot read a pricing page — able to check before building.
2. Mark tiered actions in the plugin index and on each plugin's docs page.
3. Return the violation from `validate_workflow` as a warning so a draft can be checked before creation. This needs #10b's draft-validation form to exist.
4. For the hackathon specifically: say plainly in the quickstart which actions need a paid plan, or grant participants Pro for the event. Judging on "use of the marketplace" while gating the action that makes a listing worth paying for is a mismatch worth closing.

**What we shipped instead.** A listing built only from free actions — `mirsad-safe-queue`, live and publicly resolvable via `get_workflow_listing` with no auth. Listing, slugs, input/output schemas, and public discovery all work fine on the free plan; only the Code node is gated.

---

## 15. 🟠 Pricing a listing requires unlisting it first, and the docs say the opposite

**What happened.** The Marketplace docs state: *"You can adjust pricing anytime post-launch. Calls settle at the rate active when execution occurs."* The natural reading — and the natural implementation — is list, then price.

The schema for `update_workflow_listing` says otherwise:

```
"priceUsdcPerCall": { "type": "string", "description": "Updated price in USDC (only allowed while unlisted)" }
```

So the working order is **unlist → set price → list**. Doing it the documented way leaves `priceUsdcPerCall: null` on a live listing — a *free* listing, silently, with no error to tell you the price didn't take. That is the worst possible failure mode for a monetization feature: it looks like it worked.

The type is also worth flagging: `priceUsdcPerCall` is a **string**, not a number, which is defensible for decimal precision but is not what a caller writing `0.05` expects.

**Proposed fix.** Either allow pricing a listed workflow (and match the docs), or return an explicit error when a price is submitted for a listed workflow instead of accepting the call and ignoring the field. If the constraint is deliberate, the docs sentence should read *"unlist the workflow to change its price."* Cheapest correct fix: have `list_workflow` accept `priceUsdcPerCall` directly, so listing and pricing are one atomic operation and the ordering trap disappears.

---

## 16. 🟡 `integrationId` is required on Safe plugin nodes but absent from the action schema

`get_plugin` reports `safe/get-pending-transactions` as needing `safeAddress` and `network`, with `signerAddress` optional. Building a node from exactly that fails at runtime with *"Safe API key is required. Configure it in the integration settings"* — even with the Safe credential already configured on the org.

The missing piece is `integrationId`, pointing at the credential's id from `/api/integrations`. It appears in no schema and in no example. The error message is good — it names the problem and where to fix it — but it sends you to the connections page, which is where you already were, rather than telling you the node needs to reference the connection explicitly.

**Proposed fix.** Add `integrationId` to `requiredFields` for every action with `requiresCredentials: true`, and extend the error to *"…or the node is missing `integrationId`."* Better still: default it to the org's single credential of the matching type when exactly one exists, which is the overwhelmingly common case.

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
