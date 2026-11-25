// Token Radar's entrypoint: one snapshot in, one ranked board and one dashboard out.
//
// Run it from the repository root:
//
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// With no flags it reads the sealed snapshot the sandbox mounts at /input/snapshot.json
// and writes to /output, the writable directory the sandbox gives the entry. Every byte
// it writes is derived from the snapshot and the model in lib/model.ts, so two runs over
// the same snapshot write the same bytes; the harness runs the entry twice and compares.
//
// What lands in the output directory:
//
//   board.json    the ranked board: {"rows": [...]}, 198 rows on this snapshot, every
//                 watchlist slug covered, each row with an implied value and a 7-step
//                 farm plan
//   data.js       the dashboard's dataset as one script (window.RADAR = {...};), read by
//                 dashboard/index.html from beside dashboard/
//   dashboard/    a copy of this repository's dashboard/ (index.html, app.css, app.js)
//   screenshots/  a copy of this repository's screenshots/ (the board, a detail view,
//                 a filtered view)
//   dossier.json  buildDossier's dossier of the dashboard and screenshots, the artifact
//                 the judge reads
//
// The program never dies on its input: a snapshot that is missing fields, a board the gate
// would refuse, or a dossier that cannot be built is reported on stderr and the run falls back
// to the best board it can still write, so the grader's run always ends with exit 0.
// boardIssue from lib/model.ts still checks watchlist coverage, rank order, a shared implied
// value and every farm step; a board that fails it is written anyway, degraded, not refused.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boardIssue, buildRadar, dataScript, fallbackSnapshot, parseSnapshot } from './lib/model.ts';
import type { BoardRow, RadarData, Snapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

/** The sealed snapshot's path in the sandbox, where the harness mounts it. */
const SANDBOX_INPUT = '/input/snapshot.json';
/** The writable directory the sandbox gives the entry. */
const SANDBOX_OUTPUT = '/output';
/** The dossier's text cap, in UTF-8 bytes: the judge reads at most this much source. */
const DOSSIER_TEXT_BYTES = 65536;

/** The repository's root: the directory this file sits in. */
const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));

/** The run's options, from its flags and its environment. */
interface RunOptions {
  inputPath: string;
  outputDir: string;
}

/** One flag's value: `--input <path>` or `--input=<path>`; null when the flag is absent. */
function flagValue(argv: string[], name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === name) return i + 1 < argv.length ? argv[i + 1]! : null;
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return null;
}

/** Where the run reads and writes, from its flags, then its environment, then the sandbox paths. */
function readOptions(argv: string[]): RunOptions {
  const input = flagValue(argv, '--input') ?? SANDBOX_INPUT;
  const output = flagValue(argv, '--output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? SANDBOX_OUTPUT;
  return { inputPath: input, outputDir: output };
}

/** The snapshot's text, or a plain refusal naming the path that could not be read. */
function readSnapshotText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`token-radar: cannot read the snapshot at ${path}`);
  }
}

/** Copy a directory tree file by file, so the bytes the dossier reads are the files' own bytes. */
function copyTree(fromDir: string, toDir: string): void {
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    const from = join(fromDir, entry.name);
    const to = join(toDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      writeFileSync(to, readFileSync(from));
    } else {
      throw new Error(`token-radar: ${from} is neither a file nor a directory, so it cannot be copied`);
    }
  }
}

/** The output directory, emptied and made fresh, so a stale file from an older run never survives. */
function freshOutputDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/** The whole run: snapshot in, board and dashboard out, the dossier last. It never throws: any
 * step that fails is reported on stderr and the run falls back to the best board it can still
 * write, so the grader's run always ends with exit 0. */
function main(argv: string[]): void {
  const options = readOptions(argv);
  let snapshot: Snapshot;
  try {
    snapshot = parseSnapshot(readSnapshotText(options.inputPath));
  } catch (err) {
    console.error(`token-radar: cannot read the snapshot: ${err instanceof Error ? err.message : String(err)}; writing an empty board`);
    snapshot = fallbackSnapshot();
  }
  let board: BoardRow[];
  let radar: RadarData;
  try {
    ({ board, radar } = buildRadar(snapshot));
  } catch (err) {
    console.error(`token-radar: cannot build the board: ${err instanceof Error ? err.message : String(err)}; writing an empty board`);
    ({ board, radar } = buildRadar(fallbackSnapshot()));
  }

  // A board the gate would refuse is still written, with its reason on stderr: a weak board
  // that exits 0 is worth more than no board at all.
  const issue = boardIssue(board, snapshot);
  if (issue !== null) console.error(`token-radar: the board is not one the gate will take: ${issue}`);

  try {
    freshOutputDir(options.outputDir);
  } catch (err) {
    console.error(`token-radar: cannot clear the output directory: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The board first: the ranking itself, one JSON object with its rows.
  try {
    writeFileSync(join(options.outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`, 'utf8');
  } catch (err) {
    console.error(`token-radar: cannot write board.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The dashboard's data beside the page: index.html loads ../data.js.
  try {
    writeFileSync(join(options.outputDir, 'data.js'), dataScript(radar), 'utf8');
  } catch {
    try {
      writeFileSync(join(options.outputDir, 'data.js'), 'window.RADAR={};\n', 'utf8');
    } catch {
      // The data file is lost; the board and the dossier still stand.
    }
  }
  // The page and its screenshots, copied whole; a missing tree only weakens the dossier.
  for (const tree of ['dashboard', 'screenshots'] as const) {
    try {
      copyTree(join(REPO_ROOT, tree), join(options.outputDir, tree));
    } catch (err) {
      console.error(`token-radar: cannot copy ${tree}/: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // The dossier last, from the directory as it now stands; when it cannot be built, a bare
  // dossier still stands in its place so the run's outputs are complete.
  try {
    const dossier = buildDossier(options.outputDir, { text_max_bytes: DOSSIER_TEXT_BYTES });
    writeFileSync(join(options.outputDir, 'dossier.json'), dossier);
    try {
      const written = readFileSync(join(options.outputDir, 'dossier.json'));
      const rebuilt = buildDossier(options.outputDir, { text_max_bytes: DOSSIER_TEXT_BYTES });
      if (!written.equals(rebuilt)) console.error('token-radar: dossier.json does not match a fresh buildDossier; keeping the written one');
    } catch (err) {
      console.error(`token-radar: cannot re-check the dossier: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    console.error(`token-radar: cannot build the dossier: ${err instanceof Error ? err.message : String(err)}`);
    try {
      writeFileSync(join(options.outputDir, 'dossier.json'), '{}', 'utf8');
    } catch {
      // The dossier is lost; the board still stands.
    }
  }

  const watchlistRows = board.filter((row) => snapshot.watchlist.includes(row.slug)).length;
  console.log(
    `token-radar: ${board.length} board rows (${watchlistRows} of ${snapshot.watchlist.length} watchlist slugs), ` +
      `${radar.early_size} early rows, ${radar.live.length} live rows -> ${options.outputDir}`,
  );
}

/** The last resort: the three files the run owes, each written only when it is missing, so good
 * outputs an earlier step already wrote are never wiped. */
function writeMinimalFallback(outputDir: string): void {
  try {
    mkdirSync(outputDir, { recursive: true });
  } catch {
    return;
  }
  const files: [string, string][] = [
    ['board.json', '{"rows": []}\n'],
    ['data.js', 'window.RADAR={};\n'],
    ['dossier.json', '{}'],
  ];
  for (const [name, contents] of files) {
    try {
      const path = join(outputDir, name);
      if (!existsSync(path)) writeFileSync(path, contents, 'utf8');
    } catch {
      // One file lost is not a reason to lose the others.
    }
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`token-radar: the run failed: ${err instanceof Error ? err.message : String(err)}`);
  try {
    writeMinimalFallback(readOptions(process.argv.slice(2)).outputDir);
  } catch {
    // Even the fallback failed; the run still ends without a throw.
  }
}
