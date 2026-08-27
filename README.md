# Millwright

Millwright is a pre-alpha interactive agent harness being prepared for a native
Millrace runner mode.

This repository starts from the complete upstream 0.7.2 source rather than a
thin wrapper or a package-by-package reimplementation. The goal is to preserve
the upstream interactive TUI, persistent RLM environment, compaction,
extensions, and session behavior while adding a bounded headless execution
surface that Millrace can govern as a stage runner.

> **Status:** Source-baseline work only. Millwright has not been released and the
> `millwright-agent` npm package has not been published. The disposable release
> candidate uses the Millwright package, command, path, and environment identity;
> retained upstream package keys remain internal implementation details.

- Target repository: `github.com/tim-osterhus/millwright`
- Intended npm distribution: `millwright-agent`
- Intended executable: `millwright`

## Environment identity

Millwright application controls use the `MILLWRIGHT_*` prefix. The product
identity proof rejects inherited `PI_*` aliases; provider credentials such as
`PRIME_API_KEY` remain provider-specific inputs.

| Variable | Purpose |
| --- | --- |
| `MILLWRIGHT_CODING_AGENT_DIR` | Override the user state root (default: `~/.millwright/`) |
| `MILLWRIGHT_SESSION_DIR` | Override session storage |
| `MILLWRIGHT_CACHE_RETENTION` | Set to `long` for extended provider prompt caches |
| `MILLWRIGHT_OAUTH_CALLBACK_HOST` | Override the local OAuth callback bind host |
| `MILLWRIGHT_MCP_OAUTH_CALLBACK_PORT` | Override the base MCP OAuth callback port |
| `MILLWRIGHT_SHARE_VIEWER_URL` | Override the share viewer base URL (default: `https://gist.github.com/`) |
| `MILLWRIGHT_TUI_WRITE_LOG` | Capture the raw TUI output stream at an explicit path |
| `MILLWRIGHT_HARDWARE_CURSOR` | Set to `1` to enable the hardware cursor |
| `MILLWRIGHT_CLEAR_ON_SHRINK` | Set to `1` to clear unused rows after content shrinks |
| `MILLWRIGHT_DEBUG_REDRAW` | Set to `1` to write redraw diagnostics below Millwright state |
| `MILLWRIGHT_TUI_DEBUG` | Set to `1` to write detailed render diagnostics under `~/.millwright/tui-debug` |

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

- an interactive TUI that preserves the inherited harness behavior;
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
terms in `LICENSES/Prime-Agent-MIT.txt`. Package-level release metadata and the
combined public-artifact license expression are finalized by the package-closure
milestone rather than this identity overlay.
