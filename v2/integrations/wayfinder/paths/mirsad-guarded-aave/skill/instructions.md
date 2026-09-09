# MIRSAD Guarded Aave

Use this Path only for the Phase 0 read-only capability probe.

1. Run `wayfinder path doctor --path .`.
2. Run `python scripts/wf_run.py` from an installed export, or
   `wayfinder path exec --path-dir .` from this source directory.
3. Confirm that the result identifies Base chain `8453`, a recent block, and an
   active, unpaused, unfrozen USDC reserve.
4. Do not request or read `KEEPERHUB_API_KEY`. The eventual KeeperHub call must
   be made by a separate trusted executor after a deterministic MIRSAD allow.
5. Do not publish this Path and do not sign or broadcast any transaction without
   separate post-Phase-0 authorization.
