# MIRSAD

**A watchtower for multisig treasuries. It reads the bytes your signers are about to approve, and when they don't match the story, it stops the transaction onchain — through [KeeperHub](https://keeperhub.com).**

Bybit lost $1.4 billion to a signing interface that displayed one transaction and produced another. Resolv lost $25 million to a compromised deployment key. In both cases the contracts were correct and the signatures were valid. What failed was the layer between deciding and executing.

Most treasury agents ask *is this position unhealthy?* MIRSAD asks the question that actually loses money:

> **Is the transaction your CFO is about to sign the transaction they think it is?**

And when the answer is no, it does something about it. Not an alert. A revert.

---

## The claim, demonstrated

A 2-of-3 Safe on Sepolia holding 0.05 ETH. An attacker queues a drain. **All three owners sign it** — one more than the threshold requires.

```
$ pnpm hardhat run scripts/demo-veto.ts --network sepolia

Safe      : 0x499d502527243c56434749CAbd01A115E298e338
threshold : 2 of 3
balance   : 0.05 ETH

[1] attacker queues a drain of 0.04 ETH to 0x…dEaD
    safeTxHash 0x8e526a33de78a5a76cec64232eb2a5e338f4342cf67d738844f3433c50442f49

[2] MIRSAD verdict: VETO
    writing onchain via KeeperHub...
    completed  gas 116332  sponsored=true
    https://sepolia.etherscan.io/tx/0x08a961792d5fefd72607a90ad5cd92f43d85cf370ddab54856783a2d43f56d65

[3] registry.isVetoed(safeTxHash) = true

[4] all 3 owners sign (threshold is 2)...
    REVERTED: MirsadVeto(0x8e526a33…2f49)

    balance before : 0.05 ETH
    balance after  : 0.05 ETH

    The treasury did not move. Three signatures were not enough.
```

That last line is the entire product. Everything below explains how it is true.

---

## Live on Sepolia

Both contracts are verified — read the guard's logic yourself rather than trusting this document.

| | |
|---|---|
| `MirsadVerdictRegistry` | [`0xe51388ac0CB9Bcc36548E2D0F163055FaE402256`](https://sepolia.etherscan.io/address/0xe51388ac0CB9Bcc36548E2D0F163055FaE402256#code) |
| `MirsadGuard` | [`0x997E4CA7e93696bA11d65cC390A1CEC3aC149E04`](https://sepolia.etherscan.io/address/0x997E4CA7e93696bA11d65cC390A1CEC3aC149E04#code) |
| Guarded Safe | [`0x499d502527243c56434749CAbd01A115E298e338`](https://app.safe.global/transactions/queue?safe=sep:0x499d502527243c56434749CAbd01A115E298e338) — 2-of-3, real Safe v1.4.1 |

**Transactions MIRSAD executed through KeeperHub**, all gas-sponsored:

- [`0x8005afea…`](https://sepolia.etherscan.io/tx/0x8005afea60553cf4f41e34d015216be45c02a7e5ef8f3c0fb57849a4c38741d2) — vetoed an owner swap disguised as *"Rotate the hardware wallet for owner 3, per our key-rotation policy."*
- [`0x8861e9eb…`](https://sepolia.etherscan.io/tx/0x8861e9ebc4d5873394ee7165d0fe09c4b3ba2c699cc2f040e15825f2bb74f8ee) — vetoed an attempt to **remove MIRSAD's own guard**, filed as *"Routine maintenance: clear a deprecated module reference."*
- [`0x08a96179…`](https://sepolia.etherscan.io/tx/0x08a961792d5fefd72607a90ad5cd92f43d85cf370ddab54856783a2d43f56d65) — the veto from the demo above.

Both of the first two were found and blocked **with no human in the loop**.

---

## How it works

```
Safe pending queue
   │  poll (KeeperHub Safe plugin, via a KeeperHub workflow)
   ▼
deterministic rules ──────────► findings
   │                               │
   ▼                               │
intent-drift classifier ───────────┤
   │                               ▼
   │                          verdict: ALLOW | WARN | VETO
   │                               │
   └── audit trail ◄───────────────┤  hash-chained, tamper-evident
                                   │
                          VETO ────┴──► KeeperHub execute_contract_call
                                             │
                                             ▼
                                   MirsadVerdictRegistry.setVerdict()
                                             │
                                             ▼
                              MirsadGuard.checkTransaction() reverts
                              inside Safe.execTransaction — regardless
                              of how many owners signed
```

A Safe guard is a native Safe primitive: install it once with `setGuard`, and every `execTransaction` must pass through it. MIRSAD writes verdicts to a registry; the guard reads that registry. Signatures never enter into it.

**What it detects.** Delegatecall. Owner additions, removals, and swaps. Threshold changes. Module enablement — which lets funds move with *no signatures at all*. Guard and fallback-handler tampering. Effectively-unlimited token approvals. Payments to addresses outside the treasury's address book. Proportional drains. Proxy upgrades.

**What the model adds.** Rules see structure; they cannot read a proposal and tell you the calldata contradicts it. Given a transaction described as *"Routine monthly payment of 5,000 USDC to our auditor, Trail of Bits"* whose calldata is `approve(0x…dEaD, MAX_UINT256)`, the classifier returns:

> *Stated intent is a 5,000 USDC payment to Trail of Bits, but calldata is an approval — not a transfer — of an unlimited allowance to an unrelated address. The intended recipient and amount are not reflected in the calldata.*

That sentence is what a treasurer reads before deciding not to sign.

---

## Three decisions worth arguing about

### The model cannot veto. Only rules can.

Every model finding is tagged `source: "model"`, and the verdict function clamps a model VETO down to WARN — in code, not by convention:

```ts
const severity = f.source === "model" && f.severity === Verdict.Veto ? Verdict.Warn : f.severity;
```

An LLM is never the only thing standing between a treasury and a drain. It adds reasoning to a decision deterministic code already reached. There is a test named *"the model can never veto alone."* If the classifier's provider is down, MIRSAD keeps working — rules-only is a supported mode, not a degraded one, and there is a test that points the classifier at a dead socket and asserts the loop survives.

### The guard fails **open**.

If MIRSAD has never assessed a transaction — we were offline, or it was queued and executed inside one polling interval — execution proceeds.

This is deliberate and it is the uncomfortable choice. A guard that failed closed would brick the treasury the moment the watcher went offline, converting our downtime into their outage. That is a worse failure than the one we prevent. Operators who disagree can set `requireAssessment`, and there is a test for each behaviour.

### Verdicts are write-once.

The registry refuses to overwrite an existing verdict with a different one. An attacker who compromises the writer key cannot quietly un-veto a pending drain. Identical replays are accepted silently, so retries and idempotent re-writes stay safe.

This surfaced during development as an apparent bug — the loop kept failing to re-veto an already-vetoed transaction. It was the protection working. The fix was to read `isVetoed` before writing and treat *already enforced* as success.

---

## The audit trail is evidence, not a log file

A treasury-security tool whose own records can be edited afterwards proves nothing. Each entry carries the hash of the entry before it.

```
$ pnpm run audit

#0  2026-08-05T21:08:38.387Z  VETO
  safeTx   0xd1ae867813f0881dadcd2a53c5a5c09b7448a760dd474b8e9818e1d730776ab4
  reason   0x0c53a4cd46d384b2eb7ab432e40de0bb1fa84ab7461cd78bb859df58abf0389b
  [VETO] guard-change (rule) Transaction REMOVES the Safe's transaction guard.
  onchain  https://sepolia.etherscan.io/tx/0x8861e9eb…f8ee  gas=116320

chain verified: 3 records, unbroken.
```

Editing, deleting, or reordering history breaks the chain, and `verify()` names the first entry that fails. Corrupting the file is reported as a chain break rather than crashing the reader — a crash would hide the rest of the log from whoever is investigating.

The `reason` hash is **exactly** the `reasonHash` committed onchain by the veto. Anyone holding this file can verify that an onchain verdict matches the reasoning that produced it. A test pins that equality, and another proves execution results are excluded from the hash — they are learned after the verdict, so including them would make the onchain commitment unverifiable.

---

## Reproduce it

```bash
pnpm install
cp .env.example .env          # KeeperHub kh_ key, Safe API key, RPC
pnpm build
pnpm run doctor                   # reports exactly what is still missing
```

Then, against the live Sepolia deployment:

```bash
# Queue an attack as a compromised proposer would.
# scenarios: drain | delegatecall | owner-swap | guard-removal
cd packages/contracts
SCENARIO=owner-swap pnpm hardhat run scripts/queue-attack.ts --network sepolia

# Watch MIRSAD find it, judge it, and veto it onchain.
pnpm run watch

# Read the trail and verify the hash chain.
pnpm run audit
```

Or run the whole thing end to end in one command:

```bash
cd packages/contracts
pnpm hardhat run scripts/demo-veto.ts --network sepolia
```

`MIRSAD_ARMED` defaults to `false`. Arming the onchain response is an explicit act.

---

## Built on KeeperHub

MIRSAD does not manage keys, nonces, gas, or retries. That is the point of the hackathon and the point of the product.

**MCP server** — every onchain action goes through `https://app.keeperhub.com/mcp` over JSON-RPC. **Direct execution** — `execute_contract_call` follows the documented safe-write sequence exactly: simulate, assert `success && !wouldRevert`, resend with an idempotency key, poll with bounded backoff. Skipping the preflight is how agents broadcast transactions that were always going to revert, so the client exposes it as one method that cannot be half-followed. **Workflow builder** — the queue poller is a KeeperHub workflow built programmatically through MCP. **Safe plugin** — `safe/get-pending-transactions` is the trigger. **Gas sponsorship** — every MIRSAD transaction so far has been sponsored; the wallet's balance is unchanged since it was funded. **Private routing** — Sepolia has `usePrivateMempoolRpc` enabled.

### And MIRSAD supplies KeeperHub too

The audit is published as a paid marketplace listing, callable by any organization's agent:

```
slug   mirsad-safe-guard        $0.05 USDC per call
mcp    https://app.keeperhub.com/mcp/w/mirsad-safe-guard
call   https://app.keeperhub.com/api/mcp/workflows/mirsad-safe-guard/call
```

```json
{ "safe": "0x499d…e338", "assessed": 3, "vetoed": 2, "warned": 1,
  "transactions": [
    { "verdict": "VETO", "findings": [{ "code": "guard-change",
        "summary": "Changes or removes the transaction guard. An attacker does this first." }] }
  ]}
```

The detectors run inside KeeperHub's sandboxed Code action, not on our infrastructure — a caller depends on KeeperHub's uptime rather than ours, which is the correct architecture for something sold as a service. Settlement is per call in USDC over x402 or MPP.

---

## Repository

```
packages/core        watch loop, detectors, classifier, KeeperHub client, audit trail
packages/contracts   MirsadVerdictRegistry, MirsadGuard, deploy + attack + demo scripts
apps/agent           doctor | watch | audit | publish
docs/FRICTION.md     a teardown of zero-to-first-transaction on KeeperHub
```

**72 tests.** The contract suite runs against real Safe v1.4.1 contracts rather than mocks — the central claim is only worth something if it holds against the implementation a treasury actually runs.

---

## What this is not

It does not stop a malicious transaction that is queued and executed faster than one polling interval. It does not protect a 1-of-1 Safe from its own owner, who can remove the guard — though MIRSAD will veto that attempt, and did. It does not read Safe's off-chain proposal metadata yet, so the classifier is strongest when a stated intent is supplied alongside the transaction. Token-denominated drains are detected structurally, by allowance and recipient, not by USD value.

The address book is currently configuration. In production it should be onchain and itself guarded, or an attacker who can edit your config has already won.

---

## docs/FRICTION.md

Sixteen items logged while building this, in real time, each with a proposed fix. The most consequential: the documented parameters for `execute_contract_call` — the primary write path — do not match the schema the server accepts, and the same drift affects four more tools. One fix retires most of them: generate the docs page from `tools/list`, where the field descriptions are already better than the published ones.

---

*مِرْصاد — the watchpost; the place from which one lies in wait.*

MIT
