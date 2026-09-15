---
name: parquetly-verify
description: Build, test, package, and optionally install the Parquetly VS Code extension, then report results faithfully. Use after any change to src/, media/, package.json, webpack/tsconfig, or test/ in the Parquetly repo; before reporting Parquetly work as done; or when asked to run, verify, test, package, or install Parquetly.
---

# Parquetly verification gate

Parquetly is not done until this gate passes. Run the steps in order and stop at the first
failure. Fix the cause, then restart from step 1.

## 1. Quick static checks

```bash
npx tsc --noEmit -p tsconfig.json
node --check media/main.js
```

`media/main.js` ships unbundled and is never type-checked. `node --check` is the only thing
that catches a syntax error there before the full suite does.

## 2. Full test suite

```bash
npm test
```

`pretest` builds the **production** bundle first, so the host suites test exactly what ships.
The runner prints each suite's `FAIL` lines, then a summary table, and exits non-zero on any
failure.

| Suite | File | What it proves |
|---|---|---|
| webview | `test/webview.test.mjs` | Real `media/main.js` in jsdom, fed real rows from `inputs/`: rendering, virtualization, sort, search, every SQL operator against computed ground truth, selection, copy, columns panel, menus, stats, filters, plots, go-to-row, export, diff, large-file responsiveness |
| edit-mode | `test/edit-mode.test.mjs` | Inline editing under **real browser event sequences** (`click, click, dblclick`), Tab/Enter/Escape, consecutive edits, type detection, undo, the read-only block |
| host | `test/host.test.cjs` | Bundled `dist/extension.js` with a stubbed `vscode` module: activation, CSP/nonce, all required DOM ids, the message protocol, normalization, batching, export, save dialog, clipboard, diff, error path |
| roundtrip | `test/roundtrip.test.cjs` | Save writes real Parquet: types preserved, every cell identical, nulls kept, only the offending column widens, 500k rows, cancel path |
| pyarrow | `test/crosscheck_pyarrow.py` | An independent Parquet implementation agrees the written files are valid and equal to their sources |

**pyarrow is optional, but a skip is not a pass.** If the summary says `SKIP pyarrow`, report
that the cross-implementation check did not run. If the change touched how files are written,
install it (`python -m pip install pyarrow`) and re-run rather than shipping unchecked.

## 3. When something fails, decide which side is wrong

Before changing anything, establish whether the **product** or the **test** is wrong, and say
which in your report. Never edit an assertion just to make it pass.

- **Product bug:** the behaviour contradicts `docs/prompt.md` (including its Approved
  deviations) or is plainly broken for a user.
- **Test bug:** the assertion encodes a wrong expectation. Past example: a test edited a cell
  in the column the grid was sorted by, then asserted the row stayed at position 0. The row
  correctly re-sorted away; the fix was to sort by a different column first.

For a product bug, **write the regression test first and watch it fail** against the unfixed
code. A test that has only ever passed proves nothing. See
[references/testing-patterns.md](references/testing-patterns.md) for how the harnesses work and
how to add checks.

## 4. Package

```bash
npm run vsce:package
```

Check the file list vsce prints. The VSIX must contain **only**:

```
extension/LICENSE.txt
extension/package.json
extension/readme.md
extension/dist/extension.js
extension/images/<the file named by "icon" in package.json>
extension/media/main.js
extension/media/styles.css
```

plus `[Content_Types].xml` and `extension.vsixmanifest`. vsce rewrites relative README links
to `https://github.com/barathjk/parquetly/blob/HEAD/...` using the `repository` field, and fails
if it cannot. That failure means a README link would be broken on the store listing, so fix
the link — do not re-add `--allow-missing-repository`. If `test/`, `docs/`, `.claude/`,
`inputs/`, `src/` or `node_modules/` appear, fix `.vscodeignore` before going further.

## 5. Install — only when asked, or as part of an end-to-end check the user requested

```bash
code --install-extension parquetly-<version>.vsix --force
code --list-extensions --show-versions | grep -i parquet
```

If `code` is not on PATH, locate it with `which code` (Git Bash) or
`(Get-Command code).Source` (PowerShell) rather than guessing an install path. An installed
build does not take effect in open windows: **tell the user to run `Developer: Reload Window`.**

## Reporting

- Quote counts from the actual output (`82/82`, `39/39`), never from memory or an earlier run.
- Name every skipped check and why it was skipped.
- If a failure was a test bug, say so and state the corrected expectation.
- If you did not run a step, say you did not run it.

## Pitfalls

- **Fixtures are required.** The suites assert on the exact contents of
  `inputs/titanic.parquet` (891 rows × 12 columns) and `inputs/sample-large.parquet`
  (500,000 rows × 4 columns). The runner refuses to start without them.
- **The host suites load `dist/`, not `src/`.** Running `node test/run-all.mjs` directly
  tests a stale bundle if you skipped the build. Use `npm test`.
- **Test output lives in the OS temp directory** and is deleted after each run. Never write
  test output into `inputs/`.
- **Commands that read stdin hang the shell.** A redirect such as `cat > "$DIR/file"` with an
  unset `$DIR` and no heredoc waits forever. Write files with the Write tool instead.
