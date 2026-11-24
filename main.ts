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
// The program refuses to write a board the gate would reject: boardIssue from lib/model.ts
// checks watchlist coverage, rank order, a shared implied value and every farm step, and
// the run stops with that reason instead of handing in a board that cannot rank.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
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

/** The whole run: snapshot in, board and dashboard out, the dossier last. */
function main(argv: string[]): void {
  const options = readOptions(argv);
  const snapshot = parseSnapshot(readSnapshotText(options.inputPath));
  const { board, radar } = buildRadar(snapshot);

  const issue = boardIssue(board, snapshot);
  if (issue !== null) throw new Error(`token-radar: the board is not one the gate will take: ${issue}`);

  freshOutputDir(options.outputDir);

  // The board first: the ranking itself, one JSON object with its rows.
  writeFileSync(join(options.outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`, 'utf8');
  // The dashboard's data beside the page: index.html loads ../data.js.
  writeFileSync(join(options.outputDir, 'data.js'), dataScript(radar), 'utf8');
  // The page and its screenshots, copied whole.
  copyTree(join(REPO_ROOT, 'dashboard'), join(options.outputDir, 'dashboard'));
  copyTree(join(REPO_ROOT, 'screenshots'), join(options.outputDir, 'screenshots'));

  // The dossier last, from the directory as it now stands, then read back and compared
  // with a fresh build, so what is written is exactly what buildDossier writes.
  const dossier = buildDossier(options.outputDir, { text_max_bytes: DOSSIER_TEXT_BYTES });
  writeFileSync(join(options.outputDir, 'dossier.json'), dossier);
  const written = readFileSync(join(options.outputDir, 'dossier.json'));
  const rebuilt = buildDossier(options.outputDir, { text_max_bytes: DOSSIER_TEXT_BYTES });
  if (!written.equals(rebuilt)) throw new Error('token-radar: dossier.json does not match a fresh buildDossier');

  const watchlistRows = board.filter((row) => snapshot.watchlist.includes(row.slug)).length;
  console.log(
    `token-radar: ${board.length} board rows (${watchlistRows} of ${snapshot.watchlist.length} watchlist slugs), ` +
      `${radar.early_size} early rows, ${radar.live.length} live rows -> ${options.outputDir}`,
  );
}

main(process.argv.slice(2));
