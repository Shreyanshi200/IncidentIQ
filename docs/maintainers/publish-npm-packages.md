# Publishing the Node.js SDK to npm

This guide is for IncidentIQ maintainers. It publishes two public packages together:

1. `@incidentiqhq/event-schema` — the shared TypeScript event contract.
2. `@incidentiqhq/node-sdk` — the application client, which depends on the schema package.

The SDK must never be published without the matching schema package.

## Before the first release

1. Create or take ownership of the `incidentiq` organization on npmjs.com. The package names in this repository use that scope.
2. Enable two-factor authentication for the npm account or organization owner.
3. Keep the repository's MIT license and copyright notice intact in every distributed package.
4. Configure npm Trusted Publishing for both packages. In each npm package's **Settings → Trusted publishing**, choose GitHub Actions and enter:

   | Field | Value |
   | --- | --- |
   | GitHub owner | `Shreyanshi200` |
   | Repository | `IncidentIQ` |
   | Workflow filename | `publish-npm.yml` |
   | Allowed action | `npm publish` |

If npm requires a package to exist before its Trusted Publishing settings are available, make the initial publish manually with a 2FA-protected npm account, then enable Trusted Publishing immediately for later releases.

The workflow uses GitHub OIDC, not an `NPM_TOKEN` secret. npm exchanges the short-lived GitHub identity for publishing access and records provenance for eligible public packages.

## What the repository verifies

Run this before opening the release pull request:

```sh
pnpm verify:npm-packages
```

It builds the two packages, creates real tarballs, installs them into a new temporary Node.js project, type-checks a consumer, and imports the SDK at runtime. It does not contact npm or publish anything.

The packages publish only their compiled `dist` files and package README. `workspace:^` is converted to a normal npm dependency during packing, so outside users receive the matching `@incidentiqhq/event-schema` version.

## Release process

1. Bump the public package versions deliberately. The first published versions are `0.1.0`; the IncidentIQ product release is `v0.5.0`.
2. Run the verification command above and open a pull request.
3. Merge the pull request into `main` after CI succeeds.
4. Create and push the product tag, for example `v0.5.0`.
5. GitHub Actions runs `publish-npm.yml`. It only publishes when `packages/event-schema` or `packages/node-sdk` changed since the previous product tag.
6. Confirm both npm package pages show the expected version and provenance information.
7. In a separate empty project, install `@incidentiqhq/node-sdk` from npm and send a test event to a non-production IncidentIQ API.

If the publishing job fails after it publishes the schema but before it publishes the SDK, rerun the job after fixing the cause. The workflow detects an already-published exact version and continues with the missing package. npm versions are immutable; bump the SDK version if its tarball needs to change.

## Updating the SDK later

Use normal semantic versioning for the public packages:

- patch: a backwards-compatible bug fix;
- minor: a backwards-compatible feature; and
- major: a breaking public API or event-contract change.

The npm package versions are intentionally independent from the IncidentIQ product version. This keeps a public SDK API change understandable even when the product release also includes API, collector, or dashboard work.
