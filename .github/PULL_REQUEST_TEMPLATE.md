## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The problem this solves, not just what the code does. -->

## How it was verified

- [ ] `pnpm verify` passes
- [ ] For launcher / CDP / fill changes: verified against a real browser and confirmed no browser processes remain after quitting

## Checklist

- [ ] `src/core/` does not import `electron`
- [ ] No plaintext credentials, internal URLs, cookies or profile data in the diff
- [ ] User-facing strings go through the i18n message table (both `zh` and `en`)
- [ ] Docs updated when behavior or architecture changed
- [ ] Version bump decided: either `package.json` is raised per [CONTRIBUTING.md](../CONTRIBUTING.md#versioning-and-releases), or this change does not need a release
- [ ] When raising the version: `CHANGELOG.md` has an entry for it, with both `### 中文` and `### English` (the release body is taken from there)
