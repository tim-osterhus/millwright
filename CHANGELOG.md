# Changelog

## 0.0.3 - Unreleased

- Correct the public npm artifact so the three private internal packages remain
  embedded without falsely declaring their external dependency trees as npm
  bundled dependencies.
- Require a clean-cache normal npm lifecycle installation during package
  verification instead of masking dependency lifecycle failures with
  `--ignore-scripts`.
- Preserve the exact v0.0.2 product behavior; this patch changes packaging and
  release verification only.

## 0.0.2 - Published, install broken

- Established Millwright as an independent Prime Agent 0.7.2 downstream under
  Apache-2.0 for new work while retaining the upstream MIT license chain.
- Replaced product-facing Prime Agent identity and state paths with
  `millwright-agent`, the `millwright` command, and workspace/user state under
  `.millwright`.
- Preserved the interactive TUI, session behavior, persistent Python kernel,
  and explicit `/refine` flow. Automatic refinement remains disabled by
  default.
- Added one reproducible public npm artifact containing the three private
  internal runtime packages and preserving ordinary third-party dependencies.
- Added non-mutating macOS and Ubuntu CI plus exact-artifact, annotated-tag,
  protected-environment npm publication plumbing.
- Restored the annotated event tag immediately after GitHub checkout so release
  topology verification sees the immutable tag object rather than only its
  peeled commit.

The release was published with valid provenance, but normal npm installation
fails because its `bundledDependencies` metadata describes a recursive closure
that the artifact does not contain. Use `0.0.3` or newer.

This release does not include native Millrace runner mode, the external
persistent-environment host, provider-native compaction, or proposal-handling
seams. Those remain future work and are not part of the `0.0.2` contract.

## 0.0.1 - Unpublished

- The immutable `v0.0.1` tag was created, but its npm publication did not occur:
  the GitHub Actions checkout replaced the local annotated tag ref with its
  peeled commit before release-topology verification.
