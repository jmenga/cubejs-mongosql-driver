# Changesets

This directory holds [Changesets](https://github.com/changesets/changesets) for
`@effectuate/cubejs-mongosql-driver`. Each `*.md` file in this directory (other
than this README) describes a pending release-worthy change.

## Quick start

```bash
pnpm changeset
```

Pick the bump type (`patch` / `minor` / `major`) and write a one-line summary.
The CLI writes a new `.changeset/<random>.md` file — commit it on your branch.

In the same branch, consume the changeset to bump versions and regenerate the
changelog:

```bash
pnpm version       # = changeset version
```

Then commit the resulting `package.json`, `npm/*/package.json`, and
`CHANGELOG.md` updates alongside the deleted changeset file, push, and open
your PR.

See [`PUBLISH.md`](../PUBLISH.md) for the full release flow, including the
GitHub Actions matrix that builds platform-specific napi-rs binaries and
publishes all seven npm packages with Trusted Publishing.
