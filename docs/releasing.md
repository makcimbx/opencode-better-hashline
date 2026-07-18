# Release Process

Maintainers use one GitHub release path and one npm publication path.

## Prerequisites

- CI is green on `main`.
- The release pull request updates `package.json`, `CHANGELOG.md`, and `.release-please-manifest.json` consistently.
- The `npm-release` GitHub environment is protected.
- Repository Actions settings allow the scoped Release Please workflow to create pull requests; default workflow permissions remain read-only.
- npm trusted publishing is configured for owner `makcimbx`, repository `opencode-better-hashline`, workflow `release-please.yml`, and environment `npm-release`.
- Node 24 and npm 11.18.0 or newer are used for publishing.

## First npm Publication

npm may require the package to exist before a trusted publisher can be attached. If `opencode-better-hashline` has never been published:

1. Verify `npm whoami` under the maintainer account with two-factor authentication.
2. Run `bun run ci` from the clean public commit selected for `v0.1.0`.
3. Install the documented pinned npm CLI, then run `PACKAGE_SMOKE_KEEP_TARBALL=1 bun scripts/package-smoke.ts`.
4. Inspect that retained `opencode-better-hashline-0.1.0.tgz` and publish the exact tested file with `npm publish ./opencode-better-hashline-0.1.0.tgz --access public`. Local publication cannot create GitHub Actions provenance.
5. Create the matching `v0.1.0` Git tag and GitHub release at that exact revision. The checked-in Release Please manifest already records this bootstrap version.
6. Configure the exact trusted publisher on npmjs.com.
7. Remove or revoke any temporary automation token; future releases use OIDC only.

Do not merge a Release Please pull request for the bootstrap version. The manual package publication and matching GitHub release establish the initial `0.1.0` baseline; Release Please handles only later versions.

Do not add `NPM_TOKEN` to the normal release workflow.

## Normal Release

1. Conventional commits on `main` cause Release Please to create or update one release pull request.
2. Review versioning, changelog, compatibility notes, benchmark claims, and packed contents.
3. Merge the release pull request after required checks pass.
4. Release Please creates the Git tag and GitHub release.
5. The publish job in the same workflow checks out the exact released SHA. A separate release-triggered workflow is intentionally not used because events created with `GITHUB_TOKEN` do not normally start another workflow.
6. The publish job checks/tests/builds, verifies the packed package through pinned OpenCode 1.18.3, pins npm 11.18.0, and publishes that exact tarball with npm OIDC provenance.
7. Verify npm provenance, package contents, `opencode plugin opencode-better-hashline`, and the GitHub release notes.

## Failure Handling

Never retag, force-push, or overwrite an npm version. Fix the cause and publish a new patch release. If GitHub release creation succeeded but npm publication failed, keep the immutable tag, resolve trusted-publisher/environment configuration, and rerun the failed publish workflow only when the package version is still absent.

Security fixes follow [SECURITY.md](../SECURITY.md) and may use a private fork/advisory until disclosure.
