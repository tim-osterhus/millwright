# Changelog

## 0.0.2 - Unreleased

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

This release does not include native Millrace runner mode, the external
persistent-environment host, provider-native compaction, or proposal-handling
seams. Those remain future work and are not part of the `0.0.2` contract.

## 0.0.1 - Unpublished

- The immutable `v0.0.1` tag was created, but its npm publication did not occur:
  the GitHub Actions checkout replaced the local annotated tag ref with its
  peeled commit before release-topology verification.
