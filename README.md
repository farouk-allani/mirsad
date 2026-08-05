# MIRSAD

> `مِرْصاد` — *the watchpost; the place from which one lies in wait.*

**A watchtower agent that guards multisig treasuries against execution-layer compromise, and executes its response onchain through [KeeperHub](https://keeperhub.com).**

Most agents that touch a treasury ask *"is this position unhealthy?"* MIRSAD asks a harder question:

> **Is the transaction your CFO is about to sign actually the transaction they think it is?**

Bybit lost $1.4B to a spoofed signing UI. Resolv lost $25M to a compromised AWS key. The contracts were fine in both cases — the execution layer was the attack surface. MIRSAD watches that surface.

---

## Status

🚧 **Under active construction** for the KeeperHub *Last Mile* hackathon (submission 2026-08-13). This README will carry the demo video, architecture, and the onchain transaction links before then.

## Repository

```
packages/core        watch loop, calldata decoding, simulation, verdict engine, audit trail
packages/contracts   MirsadVerdictRegistry + MirsadGuard
apps/agent           runnable daemon and operator CLI
docs/FRICTION.md     a live teardown of zero-to-first-transaction on KeeperHub
```

## Quick start

```bash
pnpm install
cp .env.example .env      # add your kh_ organization key
pnpm --filter @mirsad/agent run doctor
```

## License

MIT
