# Publishing the Node.js SDK to npm

This guide is for IncidentIQ maintainers. It publishes two public packages together:

1. `@incidentiqhq/event-schema` — the shared TypeScript event contract.
2. `@incidentiqhq/node-sdk` — the application client, which depends on the schema package.

The SDK must never be published without the matching schema package.

## Before the first release

1. Create or take ownership of the `incidentiqhq` organization on npmjs.com. The package names in this repository use that scope.
2. Enable two-factor authentication for the npm account or organization owner.
3. Keep the repository's MIT license and copyright notice intact in every distributed package.
4. Configure npm Trusted Publishing for both packages. In each npm package's **Settings → Trusted publishing**, choose GitHub Actions and enter:

   | Field | Value |
   | --- | --- |
   | GitHub owner | `Shreyanshi200` |
   | Repository | `IncidentIQ` |
   | Workflow filename | `publish-npm.yml` |
   | Allowed action | `npm stage publish` |

If npm requires a package to exist before its Trusted Publishing settings are available, stage the initial package version manually and approve it with a 2FA-protected npm account, then enable Trusted Publishing immediately for later releases.

The workflow uses GitHub OIDC, not an `NPM_TOKEN` secret. It stages packages for human review; a maintainer approves each staged version with 2FA before it becomes public.

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
5. GitHub Actions runs `publish-npm.yml`. It stages packages only when `packages/event-schema` or `packages/node-sdk` changed since the previous product tag.
6. On npmjs.com, open **Staged Packages**, review both package names, versions, tags, and tarball contents, then approve them with 2FA.
7. Confirm both npm package pages show the expected public version and provenance information.
8. In a separate empty project, install `@incidentiqhq/node-sdk` from npm and send a test event to a non-production IncidentIQ API.

If a version is already staged, approve or reject that stage before retrying its release. npm versions are immutable; bump the package version if its tarball needs to change.

## Updating the SDK later

Use normal semantic versioning for the public packages:

- patch: a backwards-compatible bug fix;
- minor: a backwards-compatible feature; and
- major: a breaking public API or event-contract change.

The npm package versions are intentionally independent from the IncidentIQ product version. This keeps a public SDK API change understandable even when the product release also includes API, collector, or dashboard work.
