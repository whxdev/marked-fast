[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/whxdev/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/whxdev/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# marked-fast

A dependency-free, hand-scanned Markdown renderer that is byte-identical to
`marked` 18.1.3 with GFM on — and roughly 2x faster.

## What it is

`parse(markdown)` returns exactly the string `marked.parse(markdown)` produces
under default options (`gfm: true`, `breaks: false`, `pedantic: false`),
including every quirk: reference link resolution, list tightness, table
alignment attributes, task-list checkboxes, `<br>` handling and entity
escaping. Verified case-by-case against the reference corpus (720/720).

No dependencies, no build step, no runtime beyond Node itself. `parse.js` is a
single ES module; `main.ts` is the whole driver.

## How it works

- **Single-pass index scanner.** The input is never split into a line array or
  re-walked per feature. Cursors over one string drive every block construct,
  so nested containers reuse offsets instead of copying text.
- **Block engine + inline engine, no token tree.** Blocks are parsed and
  rendered in one descent; inline content (emphasis, links, code spans, GFM
  strikethrough, autolinks) is handled by a CommonMark delimiter-run engine at
  render time. Nothing is materialised as an intermediate token list, which
  removes marked's biggest allocation source.
- **Hand-written delimiter-run scanning.** The `*` / `_` / `~` closer search is
  a manual run scanner using the same character classes as marked's three
  global `RDelim` regexes, so the delimiter event stream — and therefore the
  output — is identical, but without per-call RegExp state and backtracking.

Output is deterministic and order-stable: identical input yields byte-identical
output across runs.

## How to run

```
node main.ts
```

- reads `${MAKEFUN_INPUT_DIR:-/input}/cases.json` — an array of `{ id, markdown }`
- writes `${MAKEFUN_OUTPUT_DIR:-/output}/html.json` — a JSON array of HTML
  strings in input order

Node 22, standard library only. Nothing to install.

## License

MIT — see [LICENSE](LICENSE).
