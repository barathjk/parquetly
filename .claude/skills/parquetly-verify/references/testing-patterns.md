# Parquetly testing patterns

How the verification suites work, and how to extend them without making them lie.

## Shared conventions

Every suite uses the same tiny assertion helper and summary line:

```js
const check = (name, cond, detail = '') => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};
// ...at the end
console.log(`\n${passed}/${total} checks passed`);
if (failed.length) process.exitCode = 1;
```

`test/run-all.mjs` depends on both: it collects lines starting with `FAIL`, and reads the last
line matching `N/M ... passed` as the summary. Keep that format in any new suite, and register
the suite in the runner's `suites` array.

Always pass a `detail` that shows the **observed** value (`Rows: 314 of 891 (expected 314)`).
A failing check that only says `FAIL` forces a re-run to diagnose.

## Webview suite (`webview.test.mjs`, `edit-mode.test.mjs`)

These run the real, unbundled `media/main.js` inside jsdom.

1. **Markup comes from the provider.** The body HTML is sliced out of the `getHtml()` template
   in `src/parquetEditorProvider.ts`, between `<body>` and `<script`. The tests therefore fail
   if a toolbar id is renamed in the provider. Keep the template's `<body>` and `<script`
   markers intact.
2. **The VS Code API is stubbed.** `window.acquireVsCodeApi` returns an object whose
   `postMessage` pushes into a `posted` array. Assert on outbound messages there.
3. **jsdom has no layout.** `clientHeight` is patched to 600 so the virtual scroller renders a
   window of rows. Widths, `getBoundingClientRect()` and scroll geometry are otherwise zero,
   so do not assert on pixel positions.
4. **Data is real.** Rows are read from `inputs/` with hyparquet and delivered through the
   same `load-start` → `load-chunk` → `load-done` messages the host sends.

### Replay real browser event sequences

This rule exists because of a shipped bug. A double-click in a browser is
`mousedown, mouseup, click, mousedown, mouseup, click, dblclick`. The original test dispatched
a lone `dblclick` on a freshly queried cell, so it passed, while real double-clicks did
nothing: the click handler rebuilt `tbody.innerHTML` and detached the cell before `dblclick`
could bubble to the delegated listener.

```js
const mouse = (node, type, init = {}) =>
  node.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, view: window, ...init }));

const td = rows()[0].querySelectorAll('td')[col];  // capture the ORIGINAL node
mouse(td, 'click', { detail: 1 });
check('cell survives the selection click', td.isConnected);
mouse(td, 'click', { detail: 2 });
mouse(td, 'dblclick', { detail: 2 });                // dispatch on that same node
check('double-click opens the editor', !!body.querySelector('td.editing input'));
```

The same rule applies elsewhere:

- **Re-query the DOM after anything that can re-render** (sort, filter, commit, scroll).
  Holding a stale node reference hides detach bugs; asserting on it hides fixes.
- **Keys:** dispatch `keydown` on the focused input for editor keys, and on `document` for
  global shortcuts, with `ctrlKey: true` where needed.
- **Debounced search:** after dispatching `input` on `#search-input`, wait about 200ms before
  asserting.

### Compute expected values, don't hardcode them

```js
const truth = f => rows.filter(f).length;
const exp = truth(r => Number(r[idx('Age')]) > 30 && Number(r[idx('Survived')]) === 1);
check('SQL: AND', status().includes(`${exp} of`), `${status()} (expected ${exp})`);
```

### Watch for order-dependent state

The suites share one webview instance, so sort, filters, hidden columns and deleted rows carry
forward between checks. When a check depends on row position, set the state it needs
explicitly (for example, click a header to sort by a column you are not editing), rather than
relying on what earlier checks left behind.

## Host suites (`host.test.cjs`, `roundtrip.test.cjs`)

These load the **bundled** `dist/extension.js`.

1. **The `vscode` module is stubbed** by hooking `Module._load`:

   ```js
   Module._load = function (request) {
     if (request === 'vscode') return vscode;
     return origLoad.apply(this, arguments);
   };
   ```

   The stub implements only the APIs the extension uses: `Uri.file`/`joinPath`,
   `window.registerCustomEditorProvider`, `showOpenDialog`, `showSaveDialog`,
   `showInformationMessage`, `showErrorMessage`, `setStatusBarMessage`,
   `commands.registerCommand`/`executeCommand`, `workspace.fs.readFile`, and
   `env.clipboard.writeText`. **If the extension starts calling a new `vscode` API, add it to
   the stub in both host suites**, or they will throw.
2. **Dialogs are controlled by variables.** Set `openDialogResult` or `saveDialogResult` to a
   `Uri` to simulate a choice, or to `undefined` to simulate cancel. The host suite also
   records `lastSaveOptions`, so you can assert on the default filename and filters.
3. **A fake webview panel** captures `html`, outbound `postMessage` calls, and the
   `onDidReceiveMessage` handler, which the test calls directly:
   `await onMessage({ type: 'ready' })`.

### Round-trip checks

`roundtrip.test.cjs` saves through the host, then reads the result back **directly** with
hyparquet and compares column order, parquet types, and every cell against the source. When
run through `run-all.mjs`, it writes to a temp directory passed in `PARQUETLY_TEST_OUT` and
keeps it (`PARQUETLY_KEEP_OUTPUT=1`) so `crosscheck_pyarrow.py` can read the same files. The
runner deletes the directory afterwards.

If you add a new written-file scenario that pyarrow should also validate, write it into `OUT`
in the roundtrip suite and add a matching check to `crosscheck_pyarrow.py`.

## Adding a regression test for a bug

1. Reproduce the user's exact action, using real event sequences.
2. Run it against the **unfixed** code and confirm it fails for the reason you expect. The
   `detail` output should show the broken behaviour.
3. Fix the product code.
4. Confirm it passes, then run the whole gate. Fixes to shared paths such as rendering,
   selection and commit break unrelated checks.
