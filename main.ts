/**
 * EXSALA HERMES MOD · powered by Gienetic
 *
 * main.ts — driver for make.fun bounty `markdown-render-speed-02`.
 *
 * What it does
 * ------------
 * Reads `<input>/cases.json` — an array of `{ id, markdown }` — renders every
 * case with `parse()` from ./parse.js, and writes `<output>/html.json` as a
 * JSON array of the resulting HTML strings, in input order. `id` is metadata
 * only; position is what the harness matches on.
 *
 * Contract
 * --------
 *   input  dir : $MAKEFUN_INPUT_DIR  || /input
 *   output dir : $MAKEFUN_OUTPUT_DIR || /output
 *   in         : cases.json
 *   out        : html.json  (UTF-8, JSON array of strings)
 *
 * Runtime: Node 22, standard library only (`node:fs`, `node:path`). No deps,
 * no install step, no network. ./parse.js is a dependency-free ES module, so
 * a single `node main.ts` is the whole pipeline.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

interface Case {
  id: string;
  markdown: string;
}

const inputDir: string = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR || "/output";

const cases: Case[] = JSON.parse(
  readFileSync(join(inputDir, "cases.json"), "utf8"),
) as Case[];

if (!Array.isArray(cases)) {
  throw new Error("cases.json must be a JSON array of { id, markdown }");
}

const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
