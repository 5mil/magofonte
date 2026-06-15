# MagoFonte

> **The source of local intelligence.**

MagoFonte is an offline-first, modular, self-hosted platform for AI execution, wallet management, and distributed node operation. The name draws from Italian: *mago* (wizard) and *fonte* (source or spring), together implying a wizard's wellspring — a central engine of hidden power feeding modular subsystems.

---

## Brand Identity

- **Name:** MagoFonte
- **Tagline:** The source of local intelligence.
- **License:** Apache 2.0
- **Tone:** Arcane, serious, modular, offline-capable.
- **Design principle:** Small core, large extension surface.

---

## Architecture

MagoFonte uses a layered architecture where every subsystem has a clear semantic name and responsibility boundary.

| Module | Name | Responsibility |
|---|---|---|
| `core/` | **MagoFonte Core** | Orchestration, policy, app state, auth, routing |
| `forge/` | **MagoFonte Forge** | AI execution, model runtime, prompt pipeline, inference adapters |
| `vault/` | **MagoFonte Vault** | Wallet, keys, signing, asset storage, backups |
| `mesh/` | **MagoFonte Mesh** | Edge nodes, peers, device coordination, task distribution |
| `ward/` | **MagoFonte Ward** | Security, trust, permissions, sandboxing, hardening |
| `stream/` | **MagoFonte Stream** | Job queue, events, telemetry, logs, metrics |
| `bridge/` | **MagoFonte Bridge** | Protocol adapters and chain connectors |
| `sigil/` | **MagoFonte Sigil** | Configuration, manifests, signed metadata, version contracts |
| `ui/` | **MagoFonte UI** | Local web interface |
| `cli/` | **MagoFonte CLI** | Administrative command-line tooling |

---

## Design Principles

1. **Offline first.** No required external network call for startup or inference.
2. **Modular connectors.** Every chain, device, and protocol goes through an adapter interface.
3. **Pluggable execution.** Server and edge devices share the same job contract.
4. **Small core, large extension surface.** Keep base logic lean and push special cases to adapters.
5. **Inspectable by default.** Every module emits structured logs, metrics, and traces locally.
6. **Versioned contracts.** Configuration and node protocol are schema-versioned from day one.

---

## Tagline Options

- MagoFonte: the source of local intelligence.
- MagoFonte: offline AI, modular by design.
- MagoFonte: a self-hosted engine for intelligence and control.
- MagoFonte: your local source for AI, wallet, and node systems.
- MagoFonte: built for air-gapped, modular operation.

---

## Name Origin

| Word | Language | Meaning |
|---|---|---|
| *Mago* | Italian | Wizard, magician, sorcerer, enchanter |
| *Fonte* | Italian | Source, spring, wellspring, origin |
| **MagoFonte** | Coined | A wizard's wellspring; the source of magical/intelligent power |

---

## License

This project is licensed under the **Apache License 2.0**.

### Licensing Structure

- **Primary codebase:** Apache 2.0
- **Documentation:** Apache 2.0 or CC BY 4.0
- **Third-party dependencies:** OSI-approved licenses only, tracked in a manifest
- **Model assets:** Bundled and labeled per upstream license terms
- **Contributor policy:** DCO or CLA (TBD)

Apache 2.0 is recommended because it is permissive, widely adopted, includes a patent grant, and aligns cleanly with Gemma's Apache 2.0 licensing to minimize compatibility issues.

---

## Repository Structure (Planned)

```
magofonte/
├── core/
├── forge/
├── vault/
├── mesh/
├── ward/
├── stream/
├── bridge/
├── sigil/
├── ui/
├── cli/
├── docs/
├── project.md
├── README.md
└── LICENSE
```

---

*MagoFonte is built for those who want to own their intelligence stack — offline, modular, and fully under their control.*
