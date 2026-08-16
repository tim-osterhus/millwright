# Millwright

Millwright is a pre-alpha, Prime Agent-derived interactive agent harness being
prepared for a native Millrace runner mode.

This repository starts from the complete Prime Agent 0.7.2 source rather than a
thin wrapper or a package-by-package reimplementation. The goal is to preserve
Prime's interactive TUI, persistent RLM environment, compaction, extensions,
and session behavior while adding a bounded headless execution surface that
Millrace can govern as a stage runner.

> **Status:** Source-baseline work only. Millwright has not been released, the
> `millwright-agent` npm package has not been published, and the imported
> runtime still uses Prime Agent's package names and command paths. Runtime
> rebranding and runner integration require later reviewed milestones.

- Target repository: `github.com/tim-osterhus/millwright`
- Intended npm distribution: `millwright-agent`
- Intended executable: `millwright`

## Inspect the baseline

The current useful action is to build and test the imported source:

```bash
npm ci --ignore-scripts
npm run build
npm test
```

Lifecycle scripts are disabled in the installation step because this baseline
is being evaluated before publication. Some upstream tests may require platform
services or provider credentials; the Phase 0 evidence records any excluded
tests and the reason.

## Intended product boundary

Millwright is intended to have two operating surfaces:

- an interactive TUI that behaves like the full Prime Agent harness;
- a restricted headless mode that can run one Millrace-dispatched stage and
  return one bounded result without gaining workflow authority.

Long-lived Python environments are planned to attach through a separately
versioned workspace-local host. Millwright may use an attached environment, but
Millrace remains responsible for compiled workflow authority, dispatch,
terminal legality, and evidence admission.

None of that runner or environment integration is implemented in this baseline
commit. The current repository exists to prove the inherited application can
support those seams without replacing its agent loop, TUI, or RLM subsystem.

## Prime Agent provenance

The initial source snapshot comes from
[PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
release 0.7.2 at declared commit
`9f9501146e869466acaca66dac49cff857b7b4f9`. It was imported without upstream
Git history so Millwright remains an independent downstream repository.

See `UPSTREAM.md`, `UPSTREAM.json`, and `THIRD_PARTY_NOTICES.md` for the source,
license, and modification boundary.

## Licensing

New Millwright-authored work is licensed under Apache License 2.0 in `LICENSE`.
The imported Prime Agent and Pi-derived source remains under its retained MIT
terms in `LICENSES/Prime-Agent-MIT.txt`. Package-level license metadata remains
unchanged during this proof baseline and will be classified before any package
release.
