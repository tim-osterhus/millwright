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

The selected Phase 0 strategy keeps the complete stable Prime Agent source as
an independent downstream rather than importing individual upstream packages.
The donor commit preserves the snapshot bytes exactly, excluding only
`.DS_Store`. The following baseline commit establishes the legal/provenance
boundary, removes inherited GitHub automation, and repairs one stale `./hooks`
package declaration whose referenced upstream module does not exist.

Subsequent `0.0.1` work applies Millwright identity and state isolation without
replacing the inherited agent loop, TUI, session model, or persistent Python
kernel. The public artifact bundles the three private internal runtime packages
behind `millwright-agent`; those package keys are not separate public products.

The actual second-commit identifier is recorded outside that self-referential
commit in the Phase 0 `repository-bootstrap.json` evidence.

## Refresh policy

Upstream refreshes use a new clean, history-free Prime Agent snapshot on a
review branch. Each refresh records the source release and commit, classifies
identity and state-path changes, re-proves package closure and behavior, audits
the complete license chain, and completes release qualification. Millwright
does not automatically merge upstream history or mechanically overwrite the
downstream source.

Native Millrace runner mode, an external persistent-environment backend,
provider-native compaction, and inert proposal handling remain future work.
