# Millwright

Millwright is a Prime Agent-derived interactive agent harness. Version `0.0.3`
preserves the upstream TUI and persistent Python-backed working environment
while establishing independent product identity, state isolation, and one
reproducible npm artifact.

This repository starts from the complete upstream 0.7.2 source rather than a
thin wrapper or a package-by-package reimplementation. The goal is to preserve
the upstream interactive TUI, persistent RLM environment, compaction,
extensions, and session behavior. Native Millrace runner mode is future work,
not part of the `0.0.3` contract.

> **Status:** `millwright-agent@0.0.2` was published with valid provenance, but
> its normal npm install is broken by incomplete recursive bundle metadata.
> Version `0.0.3` corrects that package shape and requires a normal lifecycle
> install during qualification. Retained upstream package keys are private
> implementation details inside the single public artifact. The immutable
> `v0.0.1` and `v0.0.2` tags remain release-history evidence.

- Target repository: `github.com/tim-osterhus/millwright`
- Intended npm distribution: `millwright-agent`
- Intended executable: `millwright`

## Runtime baseline

- Node.js `>=22.8.0`; release qualification uses exactly Node `22.22.0` and npm
  `10.9.2`.
- User state defaults to `~/.millwright/` and can be isolated with
  `MILLWRIGHT_CODING_AGENT_DIR`.
- Automatic continual refinement is disabled by default. Use `/refine`
  explicitly when you want the interactive harness to propose or apply a
  refinement according to its current session controls.
- The public package is `millwright-agent`; the installed command is
  `millwright`.

After publication, the normal installation will be:

```bash
npm install --global millwright-agent
millwright --version
millwright
```

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

## Build and verify the baseline

The current useful action is to build and test the imported source:

```bash
npm ci --ignore-scripts
npm run check:ci
npx tsgo --noEmit
npm run build:release
npm test
```

Lifecycle scripts are disabled during the frozen source install. The release
packer and verifier perform their own isolated install smoke, including
`millwright --help` and `millwright --version`.

## Intended product boundary

The current release has one operating surface:

- an interactive TUI that preserves the inherited harness behavior.

Future work may add a restricted headless Millrace runner and attach long-lived
Python environments through a separately versioned workspace-local host.
Millrace will remain responsible for compiled workflow authority, dispatch,
terminal legality, and evidence admission. These are explicit non-goals for
`0.0.3`.

Provider-native compaction and inert proposal-handling seams are likewise not
implemented in `0.0.3`.

## Prime Agent provenance

The initial source snapshot comes from
[PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
release 0.7.2 at declared commit
`9f9501146e869466acaca66dac49cff857b7b4f9`. It was imported without upstream
Git history so Millwright remains an independent downstream repository.

See `UPSTREAM.md`, `UPSTREAM.json`, `THIRD_PARTY_NOTICES.md`, and
`docs/RELEASING.md` for provenance, maintenance, and release boundaries.

## Licensing

New Millwright-authored work is licensed under Apache License 2.0 in `LICENSE`.
The imported Prime Agent, Pi-derived source, and OpenTUI-derived terminal input
handling remain under their retained MIT terms in `LICENSES/`. The public
artifact preserves those notices while Millwright-authored changes remain
Apache-2.0.
