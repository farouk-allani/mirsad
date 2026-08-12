# MIRSAD — DoraHacks submission copy

Paste-ready text for **The Last Mile** (KeeperHub). Every figure here is verified against Sepolia — see "Verification" at the bottom.

---

## BUIDL name

```
MIRSAD
```

## Tagline (one line)

```
A watchtower for multisig treasuries. It reads the bytes your signers are about to approve, and when they don't match the story, it stops the transaction onchain — through KeeperHub.
```

---

## Vision — the problem this project solves

```
Bybit lost $1.4 billion to a signing interface that displayed one transaction and produced another. Resolv lost $25 million to a compromised deployment key. In both cases the contracts were correct and every signature was valid. What failed was the layer between deciding and executing — the same last mile this hackathon is about.

Most treasury agents ask "is this position unhealthy?" MIRSAD asks the question that actually loses money:

    Is the transaction your CFO is about to sign the transaction they think it is?

And when the answer is no, it does something about it. Not an alert. A revert.

THE GAP

Every existing answer to this problem is a notification. A Telegram message arrives, and the transaction executes anyway, because nothing about a message changes what the chain will permit. The gap is not detection — it is enforcement. An agent that decides something is malicious but cannot act on that decision has not solved the problem; it has documented it.

HOW MIRSAD CLOSES IT

MIRSAD polls a Safe's pending transaction queue through KeeperHub's Safe plugin, decodes the calldata, and judges it against deterministic detectors: delegatecall, owner additions and swaps, threshold changes, module enablement, guard and fallback-handler tampering, unlimited token approvals, payments outside the treasury's address book, proportional drains, proxy upgrades. An LLM adds semantic intent-drift detection on top — reading a proposal's stated purpose against what the calldata actually does.

On a malicious verdict, MIRSAD writes a binding onchain veto through KeeperHub's execute_contract_call into a verdict registry. A Safe guard — a native Safe primitive, installed once with setGuard — reads that registry on every execTransaction and reverts if the hash is vetoed.

The result is a hard guarantee rather than a warning: even if every owner signs, a vetoed transaction cannot execute. That is demonstrated live on Sepolia, with all three owners of a 2-of-3 Safe signing a drain that then reverts.

THREE DECISIONS WE EXPECT TO BE CHALLENGED

1. The model cannot veto. Only deterministic rules can. Every model finding is tagged source:"model" and the verdict function clamps a model VETO down to WARN — in code, not by convention. An LLM is never the only thing standing between a treasury and a drain. If the classifier's provider is down, MIRSAD keeps working; rules-only is a supported mode, not a degraded one, and a test points the classifier at a dead socket and asserts the loop survives.

2. The guard fails OPEN. If MIRSAD never assessed a transaction — we were offline — execution proceeds. A guard that failed closed would brick the treasury the moment the watcher went down, converting our downtime into their outage. That is a worse failure than the one we prevent. Operators who disagree can set requireAssessment, and there is a test for each behaviour.

3. Verdicts are write-once. The registry refuses to overwrite an existing verdict with a different one, so an attacker holding the writer key cannot quietly un-veto a pending drain. Identical replays are accepted silently, keeping retries safe.

WHY KEEPERHUB IS LOAD-BEARING, NOT DECORATIVE

MIRSAD does not manage keys, nonces, gas, or retries. Every onchain action goes through KeeperHub's MCP server over JSON-RPC, following the documented safe-write sequence exactly: simulate, assert success && !wouldRevert, resend with an idempotency key, poll with bounded backoff. The client exposes this as a single method that cannot be half-followed, because skipping the preflight is how agents broadcast transactions that were always going to revert. The queue poller is a KeeperHub workflow built programmatically through MCP. Every MIRSAD transaction so far has been gas-sponsored.

And MIRSAD supplies KeeperHub as well as consuming it: the audit is published as a paid marketplace listing (mirsad-safe-guard, $0.05 USDC per call), with the detectors running inside KeeperHub's sandboxed Code action rather than on our infrastructure — so a caller depends on KeeperHub's uptime rather than ours, which is the correct architecture for something sold as a service.

EVIDENCE, NOT CLAIMS

Four attacks caught and vetoed onchain, all gas-sponsored, all with no human in the loop:

  Guard removal     0x500e8f4ebcce4fefa4c188f126f1b1ac3f83c07ab39f2ecf6e96ed5bd793ad91
  Hidden delegatecall  0x2f5f42bfd89c4dafb426ddd2dd84676c8c9f4255c54f4793cbd902ca9f8b7419
  Silent owner swap    0x3e037e27485252876778e4f0a351015697adf2a5e00bd57bc46ccc6a0b1b1640
  Treasury drain       0xd367d4e900dc92a6f95458a4388264b53dff89e887de23a5916a0609ef712d55

The audit trail is hash-chained and tamper-evident, and the reasonHash committed onchain by each veto is byte-for-byte the record hash in the trail. Anyone can verify that an onchain verdict matches the reasoning that produced it, using nothing but the repository and an RPC endpoint. Editing, deleting, or reordering history breaks the chain, and verify() names the first entry that fails.

72 tests. The contract suite runs against real Safe v1.4.1 contracts rather than mocks — the central claim is only worth something if it holds against the implementation a treasury actually runs.

WOULD ANYONE RUN THIS

A treasury team with a Safe would run it the day it exists. The install is one setGuard call, and the failure mode of the agent going offline is that the treasury keeps working normally.
```

---

## Category

DoraHacks lets you pick more than one. In priority order:

1. **Security** *(or "Infrastructure" if Security isn't offered)* — the honest primary. MIRSAD is a treasury-security product.
2. **AI / Agents** — required framing for this hackathon; the agent is what does the deciding.
3. **DeFi** — treasury/multisig adjacency.
4. **Developer Tools** — only if a fourth is allowed, justified by the marketplace listing and FRICTION.md.

**Don't lead with DeFi.** The field will be crowded with yield and liquidation bots, and this is deliberately not one.

---

## Links

| Field | Value |
|---|---|
| **GitHub** | *(your repo URL)* |
| **Project website** | Leave blank — or use the Etherscan address page for `MirsadGuard`, which is verified source and stronger than a landing page: `https://sepolia.etherscan.io/address/0x997E4CA7e93696bA11d65cC390A1CEC3aC149E04#code` |
| **Demo video** | *(YouTube unlisted link)* |

### The required "transaction your agent executed" link

Submit this one:

```
https://sepolia.etherscan.io/tx/0x500e8f4ebcce4fefa4c188f126f1b1ac3f83c07ab39f2ecf6e96ed5bd793ad91
```

It is the veto of an attempt to **remove MIRSAD's own guard** — the agent defending its own enforcement mechanism. If the form takes only one link, this is the most self-evidently interesting of the four.

---

## Demo video

### Title

```
MIRSAD — three signatures weren't enough: an onchain veto for multisig treasuries, via KeeperHub
```

Alternates:
- `MIRSAD — stopping a Safe treasury drain onchain, after every owner signed it`
- `The transaction your CFO is about to sign isn't the one they think it is — MIRSAD on KeeperHub`

### Description

```
MIRSAD is a watchtower agent for multisig treasuries. It reads the bytes your signers are about to approve, and when the calldata doesn't match the story, it stops the transaction onchain — through KeeperHub.

Bybit lost $1.4B to a signing interface that displayed one transaction and produced another. The contracts were correct and every signature was valid. What failed was the layer between deciding and executing.

Most treasury agents send an alert. An alert doesn't change what the chain will permit. MIRSAD writes a binding onchain veto through KeeperHub, and a native Safe guard enforces it — so even when all three owners of a 2-of-3 Safe sign, the transaction reverts.

In this demo, on Sepolia:
- an attacker queues a malicious transaction to a real 2-of-3 Safe v1.4.1
- MIRSAD polls the queue via KeeperHub's Safe plugin, decodes the calldata, and reaches a VETO
- the veto is written onchain via KeeperHub execute_contract_call — simulated first, sent with an idempotency key, polled to completion, gas-sponsored
- every owner signs and execution is attempted anyway
- it reverts with MirsadVeto

VERIFY IT YOURSELF — Sepolia
Guard removal vetoed  https://sepolia.etherscan.io/tx/0x500e8f4ebcce4fefa4c188f126f1b1ac3f83c07ab39f2ecf6e96ed5bd793ad91
Delegatecall vetoed   https://sepolia.etherscan.io/tx/0x2f5f42bfd89c4dafb426ddd2dd84676c8c9f4255c54f4793cbd902ca9f8b7419
Owner swap vetoed     https://sepolia.etherscan.io/tx/0x3e037e27485252876778e4f0a351015697adf2a5e00bd57bc46ccc6a0b1b1640
Treasury drain vetoed https://sepolia.etherscan.io/tx/0xd367d4e900dc92a6f95458a4388264b53dff89e887de23a5916a0609ef712d55

MirsadVerdictRegistry (verified)  https://sepolia.etherscan.io/address/0xe51388ac0CB9Bcc36548E2D0F163055FaE402256#code
MirsadGuard (verified)            https://sepolia.etherscan.io/address/0x997E4CA7e93696bA11d65cC390A1CEC3aC149E04#code
Guarded Safe                      https://app.safe.global/transactions/queue?safe=sep:0xe10b5A1c804b3caD6F3c44058e590dcFEC4020eC

BUILT ON KEEPERHUB
MCP server · execute_contract_call with the full simulate-then-send sequence · Safe plugin as the trigger · workflow builder via MCP · gas sponsorship · private routing · marketplace listing (mirsad-safe-guard, $0.05 USDC/call) · audit trail

The model cannot veto — only deterministic rules can. The guard fails open, so our downtime never becomes the treasury's outage. Verdicts are write-once. 72 tests, contract suite against real Safe v1.4.1.

Source: (your repo URL)
Built for KeeperHub's "The Last Mile" hackathon.

مِرْصاد — the watchpost; the place from which one lies in wait.
```

### Chapters

Adjust timings to your recording, then paste into the description — YouTube turns them into chapters automatically (the first must be `0:00`).

```
0:00 The $1.4B problem: valid signatures, wrong transaction
0:35 The Safe: 2-of-3, real Safe v1.4.1, guard installed
1:00 An attacker queues the transaction
1:30 MIRSAD polls the queue via KeeperHub's Safe plugin
2:00 Decoding the calldata — what it actually does
2:30 Verdict: VETO
2:50 Writing the veto onchain via KeeperHub (simulate → send → poll)
3:20 Confirmed onchain, gas-sponsored
3:40 All three owners sign — one more than the threshold
4:00 REVERTED: MirsadVeto
4:20 The audit trail, and why the onchain hash matches it
```

### Upload settings

- **Unlisted**, not private. Private videos are invisible to judges and this is the most common way a submission gets scored as "no demo."
- Confirm the link works in a logged-out browser before submitting.
- Keep it under ~5 minutes; execution first, architecture second.

---

## Bounty — Best Onboarding UX Improvement

Submit this **separately** as well, since it's stackable and judged on its own.

**What to point at:** [`docs/FRICTION.md`](FRICTION.md) — 17 items logged in real time while building, ordered by cost to a new builder, each with a concrete proposed fix.

**Suggested bounty blurb:**

```
docs/FRICTION.md — a teardown of zero-to-first-transaction on KeeperHub, written live over 8 days on Windows, ordered by cost to a new builder, with a concrete proposed fix for every item.

17 items. The four that cost the most:

#1  There is no Windows install path for the kh CLI. Three install methods are offered; none run on Windows. We never got the CLI working and routed everything through MCP and REST instead.

#10 The documented parameters for execute_contract_call — the primary write path — are not the ones the server accepts.

#11 The same documentation drift affects at least four more tools, so it is systemic rather than a typo. One fix retires most of it: generate the docs page from tools/list, where the field descriptions are already better than the published ones.

#14 The Code action is Pro-gated, and nothing says so until you publish — not get_plugin, not list_action_schemas, not the plugin index.

Also logged: the two API-key systems that share one word, simulate silently meaning something different as a string, /api/chains returning two different things both called an id, and gas sponsorship working on Sepolia while documented as mainnet-only.
```

---

## Verification

Checked against Sepolia on 2026-08-12 before writing any of the above:

- All four veto transactions exist with `status: 0x1`.
- `isVetoed(safeTxHash)` returns `true` on the registry for all four.
- The `reasonHash` in each transaction's calldata is byte-for-byte the `recordHash` in `data/audit.jsonl`.
- Both contracts are Etherscan-verified (`MirsadVerdictRegistry`, `MirsadGuard`).
- Safe `0xe10b5A1c…` has guard `0x997E4CA7…` in its guard storage slot and holds 0.05 ETH.
- `mirsad-safe-guard` is listed on the marketplace at $0.05/call.
- Test suite: 71 passing, 1 opt-in live-API test skipped.
