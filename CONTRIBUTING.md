# Contributing to Parquetly

## Building

```bash
npm install
npm run watch     # or: npm run compile
```

Press <kbd>F5</kbd> to launch an Extension Development Host, then open a parquet file.

```bash
npm test              # production build, then every verification suite
npm run package       # production webpack bundle
npm run vsce:package  # build the .vsix
```

`npm test` runs the real webview in jsdom and the bundled extension host against the
fixtures in `inputs/`. It then writes Parquet files and checks they round-trip exactly. If
Python with `pyarrow` is installed, an independent reader also validates those files;
otherwise that step is reported as skipped.

## Layout

Only `src/*.ts` is bundled (webpack, target node, `vscode` external) into
`dist/extension.js`. `media/main.js` and `media/styles.css` ship unbundled and use no
external UI, chart, or grid libraries. The README GIFs live in `media/assets/` and are
excluded from the `.vsix`. The only runtime dependencies are
[hyparquet](https://github.com/hyparam/hyparquet) for reading and
[hyparquet-writer](https://github.com/hyparam/hyparquet-writer) for writing.

## Reference

- [docs/prompt.md](docs/prompt.md) is the build spec, including every approved deviation
  from the original.
- [.claude/agents/parquetly-engineer.md](.claude/agents/parquetly-engineer.md) is a Claude
  Code subagent for changing and debugging the extension.
- [.claude/skills/parquetly-verify/SKILL.md](.claude/skills/parquetly-verify/SKILL.md) is the
  build → test → package gate that agent follows.
