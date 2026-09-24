# Releasing Nouva Agent

A push to the mirrored public repository's `main` starts `Auto Release` directly. The automation
reads `agent/package.json`, creates or reuses a draft `v${version}` release, and dispatches `Release`
for that exact push commit. `Release` still installs dependencies, typechecks and tests before image
publication, then signs the image before publishing the draft. Public `CI` is manual-only;
completing it does not trigger a release.

If that version is already published from the same commit, the automation exits without changing
the release. If the version points to another commit, it fails and requires a new package version.

## Before merging an exported change

The monorepo's lightweight **Agent Release Readiness** workflow is manual-only. It compares actual
exports of the selected workflow ref (candidate) and the `base_ref` input (default `main`). Changes
to exported agent code, reachable runtime modules, tests, docs, workflows or manifests require an
unreserved `agent/package.json` version. Unreachable runtime
files and monorepo-only scripts do not require a bump when the export stays byte-identical.
Versions must be valid SemVer without build metadata, usable as image tags. This checks version
availability, not ordering or permission to publish `latest`.

Dispatch it before merging, selecting the candidate branch and a base branch, tag or SHA:

```sh
gh workflow run agent-release-readiness.yml --repo nouvacloud/nouva-platform \
  --ref <candidate-branch> -f base_ref=main
```

The candidate commit supplies the exporter for both trees. The comparison has read-only permissions,
no secrets, no persisted checkout credentials and no dependency installation. It checks public tags
only: private draft reservations and future availability cannot be guaranteed by a green manual run.
Lookup failures fail closed; sync remains the authoritative pre-mutation check.

**Sync Agent Public Repo** repeats the check against the actual public mirror before replacing,
committing or pushing any content. For changed exports it also lists GitHub releases using the
existing `NOUVA_AGENT_MIRROR_TOKEN`, including untagged draft reservations. That token must have
repository contents read/write (push) permission on `nouvacloud/nouva-agent` to see drafts; a
read-only or incorrectly scoped token cannot establish draft availability. HTTP failures (including
404), malformed responses, network errors, or incomplete pagination fail closed. Listing is bounded
to ten pages of 100 releases and 30 seconds; hitting the bound requires investigation, not a bypass.
Byte-identical exports remain a no-op, even for already-released versions.

If rejected, bump the version in the monorepo, keep its workspace entry in `bun.lock` aligned, and
rerun the check. Never move a published tag or bump only the mirror. An existing draft also reserves
its version; retry its exact original release workflow rather than syncing different content under
that tag. Availability must be rechecked before publication because neither gate reserves a version.

Local preparation for graceful worker rollouts uses `0.4.37`, which retires a worker's previous
process with its configured signal and grace period instead of force-removing it, can confirm the
old process stopped before the new one starts, and reports every shutdown outcome in the rollout
result. Version availability for `v0.4.37` has not been checked during this preparation; run the
readiness check and the sync gate before publishing. Neither a local bump nor a green check is
evidence of a published image or an upgraded server.

## Manual validation and runners

Validation workflows (`Control Plane CI`, `Agent Release Readiness`, and public `CI`) run only on
manual dispatch. Deployment, runtime-image publication, mirror sync, agent releases and scheduled
monitoring retain their automation. To run broader checks independently:

```sh
gh workflow run control-plane-ci.yml --repo nouvacloud/nouva-platform --ref <candidate-branch>
gh workflow run ci.yml --repo nouvacloud/nouva-agent --ref <public-branch>
```

Linux workflow jobs use Blacksmith (`blacksmith-2vcpu-ubuntu-2404`, with existing native ARM jobs on
`blacksmith-2vcpu-ubuntu-2404-arm`). The optional extended native macOS OpenSSH check in
`Control Plane CI` remains on `macos-latest`. Blacksmith must be available to both repositories,
including the public mirror. These configuration changes do not prove runner/app access or resolve
GitHub account billing/spending-limit failures; confirm hosted execution separately.

## Prerequisites

Set these repository or organization secrets before publishing a release:

- `NOUVA_CONTROL_PLANE_URL`
- `NOUVA_AGENT_RELEASE_WEBHOOK_SECRET`

The release workflow fails before build and push if either secret is missing.

## Publish `v0.1.0`

1. Update `agent/package.json` in the monorepo to the version you intend to release, without a `v`
   prefix.
2. Merge the monorepo change to `main`.
3. Wait for `Sync Agent Public Repo`, public-repository `Auto Release`, and `Release` to complete
   successfully. Public `CI` is optional manual validation, not a prerequisite trigger.
4. Verify the image digest/signature and control-plane notification, then verify customer-agent
   rollout separately. Merge means source accepted; mirror sync means public source updated;
   release means artifacts published. None alone proves a server is running the fix. See
   [reliability-rollout.md](reliability-rollout.md) for the capability-gated deletion upgrade.

`Auto Release` keeps the GitHub Release as a draft until the image is built and signed. If
publication fails, rerun the failed `Release` workflow or dispatch it with the draft tag and exact
commit SHA. If release preparation must be repeated, dispatch `Auto Release` with the exact public
repository commit SHA. The release workflow also supports manually published releases and rejects
tags that do not match `v${agent/package.json version}`.

## Verify the published artifacts

After the workflow finishes, confirm it published all expected tags:

- `ghcr.io/nouvacloud/nouva-agent:v0.1.0`
- `ghcr.io/nouvacloud/nouva-agent:<release-commit-sha>`
- `ghcr.io/nouvacloud/nouva-agent:latest`

Then verify the control-plane notification step succeeded. The webhook payload remains:

```json
{
  "version": "v0.1.0",
  "imageRef": "ghcr.io/nouvacloud/nouva-agent@sha256:...",
  "digest": "sha256:...",
  "gitSha": "<release-commit-sha>",
  "githubReleaseId": "<github-release-id>",
  "githubReleaseUrl": "https://github.com/nouvacloud/nouva-agent/releases/tag/v0.1.0",
  "publishedAt": "<timestamp>"
}
```

## GHCR visibility

After the first successful publish, inspect the GitHub Packages entry for
`ghcr.io/nouvacloud/nouva-agent`. If GitHub created the package with private visibility, change it
to `public` so unauthenticated installs can pull both `v0.1.0` and `latest`.
