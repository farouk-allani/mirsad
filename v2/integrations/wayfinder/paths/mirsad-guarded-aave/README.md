# MIRSAD Guarded Aave — Phase 0 artifact

This is the smallest official Wayfinder Path used by the MIRSAD Phase 0
capability spike. It proves that a local, user-installed Path can run the
published Wayfinder runtime and read the live Aave V3 USDC reserve on Base.

It is intentionally read-only. It contains no wallet, private key, KeeperHub
credential, transaction builder, signer, publisher, or broadcast path.

Run it with the official CLI:

```text
wayfinder path doctor --path .
wayfinder path exec --path-dir .
```

`BASE_RPC_URL` may override the public Base RPC. The component returns the Base
block number and selected Aave reserve fields as JSON.

Product boundary: MIRSAD is a deterministic pre-execution policy gate for this
Wayfinder execution path. KeeperHub is the deterministic execution layer.
