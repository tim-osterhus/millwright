# Releasing Millwright

Millwright `0.0.1` uses a qualification-first, tag-driven release. No local
script bumps versions, commits, tags, pushes, or publishes. Publication accepts
only the artifact qualified by B004 and recorded in the immutable
`RELEASE.json` manifest.

## Prerequisites

- The source commit is clean and already pushed.
- Node is exactly `22.22.0` throughout. Qualification and artifact construction
  use npm `10.9.2`; the protected
  publish-only job upgrades to exactly npm `11.5.1`, the minimum client used by
  this release for npm trusted-publishing OIDC.
- The `npm-production` GitHub environment exists, requires operator approval,
  and is configured for npm trusted publishing.
- `millwright-agent` already exists on npm under the intended maintainer account;
  its trusted publisher is bound to `tim-osterhus/millwright`,
  `publish-npm.yml`, environment `npm-production`, and the `npm publish`
  action.
- The release version remains `0.0.1`, the package remains
  `millwright-agent`, and the artifact remains
  `millwright-agent-0.0.1.tgz`.

### Initial registry bootstrap gate

npm trusted-publisher configuration requires an existing registry package. If
`npm view millwright-agent` still returns `E404`, stop before B004 creates a
release manifest or tag. Establishing the initial package entry is a separate
operator-authorized bootstrap action; this repository contains no token-based
or placeholder-publish fallback and neither B003 nor B004 authorizes one. After
the package entry exists, configure and verify the exact trusted-publisher
binding above before resuming qualification.

## Qualification and release sequence

1. Run B004 against one clean source commit on macOS. Produce the package once,
   run the package verifier and isolated install smoke, and retain the exact
   SHA-256 and npm SHA-512 integrity.
2. Run the Ubuntu CI qualification job for that same commit. Download the
   uniquely named `qualification-report.json`, verify its SHA-256, and confirm
   that it binds the same source commit, tracked-source digest, artifact digest,
   toolchain, and successful gate set.
3. Obtain the three bounded B004 reviews: `spec-conformance`,
   `package-code-quality`, and `stateful-adversarial`. Every verdict must be
   `APPROVE` or `APPROVE-WITH-NONBLOCKING-NOTES`.
4. Construct canonical `RELEASE.json` using the frozen B003 schema. Its
   qualification attestation repeats the exact source/artifact bindings and
   hashes the canonical qualification object without its own hash field.
5. While `RELEASE.json` is the only untracked file, run the read-only release
   verifier with `--pre-tag`, `--tag v0.0.1`, and the exact artifact, package
   report, Ubuntu run, and Ubuntu report paths. Pre-tag mode waives only the
   absent tag topology; every content and evidence binding must pass.
6. Commit only `RELEASE.json` on top of the qualified source commit. The commit
   must have exactly that source commit as its sole parent.
7. Create the annotated tag `v0.0.1` at the manifest-only commit and push that
   immutable tag. Do not use a lightweight tag and never move or overwrite the
   tag.
8. The publish workflow validates tag topology and `RELEASE.json`, queries the
   attested Ubuntu run, downloads its exact report artifact, rebuilds from the
   recorded source commit in an isolated clone, and requires byte-for-byte
   digest and npm-integrity agreement.
9. Review the verification job summary. It states the source commit, artifact
   SHA-256, npm integrity, and current-run handoff artifact name.
10. Approve the `npm-production` environment only when those values match the
   B004 operator record. The protected job downloads that one current-run
   artifact, recomputes both digests, and publishes exactly the tarball with npm
   provenance.
11. Confirm the published package metadata and installed `millwright --version`
    before creating any GitHub release notes.

Approval must occur before the verified handoff artifact's 30-day retention
expires. After expiry, rerun the workflow from the same immutable tag, confirm
that it reproduces the unchanged `RELEASE.json` digest and artifact binding,
then approve the new run's handoff. Never reuse an expired artifact.

## Failure and rollback

A failed or rejected publish does not change source, `RELEASE.json`, or the
tag. If the failure is transient and no source correction is required, rerun
the same immutable tag and approve only after the complete verification job
passes again. If source must change, leave `v0.0.1` untouched and prepare a new
version with a new qualification record and tag. Never replace an npm version,
rewrite the manifest commit, or force-move a published tag.

## Upstream refresh

Refreshes are deliberate source imports, not automatic merges:

1. Retrieve a stable Prime Agent release as a clean, history-free snapshot on a
   review branch.
2. Record its repository, release, commit, retrieval date, and donor manifest.
3. Classify product-identity changes and state-path traps before applying the
   Millwright overlay.
4. Re-prove package closure, behavior preservation, state isolation,
   refinement defaults, and all retained licenses/notices.
5. Re-run the complete release qualification. Never mechanically overwrite the
   current downstream or bypass exact-artifact review.

Native Millrace runner mode and external persistent-environment hosting are
outside the `0.0.1` release process.
