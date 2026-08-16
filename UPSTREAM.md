# Upstream source

Millwright is an independent downstream of Prime Agent. Its root commit imports
the complete Prime Agent 0.7.2 source snapshot without upstream Git metadata or
history.

| Field | Value |
| --- | --- |
| Repository | `https://github.com/PrimeIntellect-ai/prime-agent` |
| Release | `0.7.2` |
| Declared upstream commit | `9f9501146e869466acaca66dac49cff857b7b4f9` |
| Snapshot retrieval date | `2026-08-14` |
| Millwright donor commit | `de71232a2effa9fc1c286e6d7ca1ae68b3fec85e` |
| Donor manifest SHA-256 | `57c34a13979f224052e64cf04e8493d96d25e3552cd9ec8ce614db5b4bb7e698` |

The first Millwright commit preserves the donor bytes exactly, excluding only
`.DS_Store`. The second commit establishes the repository's legal and
provenance boundary, removes inherited GitHub automation, and repairs one
stale `./hooks` package declaration whose referenced upstream module does not
exist. It does not implement the Millrace runner mode or rebrand the runtime.

The actual second-commit identifier is recorded outside that self-referential
commit in the Phase 0 `repository-bootstrap.json` evidence.
