# Contributing to Agent Terminal

Thanks for helping! Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Please include your operating system, Obsidian version, plugin version, the shell you use and, if an agent is involved, its name and version. Errors from the plugin appear in the developer console (*View → Toggle developer tools*) with the prefix `[AgentTerminal]`.

## Development

```bash
npm install        # installs dependencies and builds node-pty for your machine
npm run dev        # build and watch
npm run build      # production build
npm test           # unit tests (vitest)
npx tsc --noEmit   # type check
```

To try the plugin, link or copy the repository into `<test vault>/.obsidian/plugins/agent-terminal/`. Development builds do not download node-pty automatically; run `npm install node-pty` in that folder (or symlink `node_modules`) instead.

- Read [ARCHITECTURE.md](../ARCHITECTURE.md) before larger changes.
- Changes are developed test-first: add or adjust a failing test in `tests/`, make it pass, then refactor. `npm test`, `npx tsc --noEmit` and `npm run build` must pass; CI runs the same checks.
- UI text is English and uses sentence case, following the [Obsidian plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- Agent launch options in the presets are checked against each CLI's `--help`. When an agent changes its flags, update `src/core/agentTemplates.ts` and the tests together.

## Releasing

1. Update `version` in `manifest.json` and `package.json`, add the version to `versions.json` (mapped to `minAppVersion`), commit, and push a tag with the same version, for example `git tag 0.2.0 && git push origin 0.2.0`. The tag must not start with `v`: if you use `npm version`, run it as `npm version 0.2.0 --tag-version-prefix=""`, because npm adds `v` by default and Obsidian rejects such a release.
2. The **Release** workflow builds node-pty for Linux (x64, arm64), packages the prebuilt Windows and macOS binaries, runs the tests, builds `main.js` with the matching checksums and creates a **draft** GitHub release with all files.
3. Review the draft and publish it.

To package locally, `npm run package:native` writes the bundles and `native-manifest.json` to `dist/native/`; a following `npm run build` embeds that manifest.

## Website

The project website is the static site in [`docs/`](../docs/) (English at the root, Traditional Chinese in `docs/zh-TW/`). The **Pages** workflow publishes it whenever `docs/` changes on `main`.
