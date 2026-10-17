'use strict';
/**
 * Pre-generation mode: translate a whole tree in one pass.
 *
 * Doxygen calls an input filter once per file, and each call has to build a
 * `Program` and a type checker before it can resolve anything -- about 0.7 s of
 * fixed cost on a small project and ~2 s per file on a medium one, which is
 * minutes of filtering for every documentation run (see the README for the
 * measured numbers).
 *
 * Pre-generation pays that cost once: one `Program` serves every file, and the
 * pseudo-code is written into a mirror of the source tree that Doxygen then
 * reads directly, with no filter configured.
 */

const fs = require('fs');
const path = require('path');
const { createSession } = require('./index');
const { SOURCE_EXTENSIONS } = require('./names');

/** Is this a file we translate? */
function isSourceFile(file) {
  const lower = file.toLowerCase();
  return SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Every source file under `dir`, recursively.
 *
 * `skip` keeps the output directory out of the input when it sits inside the
 * tree being translated (`pregen . --out ./doxygen-pregen`), which would
 * otherwise translate the previous run's pseudo-code on the next one.
 */
function collectFiles(dir, out = [], skip = null) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (skip && path.resolve(full) === skip) continue;
    if (entry.isDirectory()) collectFiles(full, out, skip);
    else if (entry.isFile() && isSourceFile(full)) out.push(full);
  }
  return out;
}

/** Resolve the command line's paths into a list of files to translate. */
function resolveInputs(positional, skip = null) {
  const files = [];
  for (const input of positional) {
    const full = path.resolve(input);
    if (!fs.existsSync(full)) throw new Error(`no such file or directory: ${input}`);
    if (fs.statSync(full).isDirectory()) collectFiles(full, files, skip);
    else if (isSourceFile(full)) files.push(full);
  }
  return [...new Set(files)].sort();
}

/** How many files are already in a directory, recursively. */
function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else n++;
  }
  return n;
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Translate every file and write it into the output tree.
 *
 * @param {string[]} positional files and directories to translate
 * @param {object} opts CLI options; `out` is required
 */
function run(positional, opts = {}) {
  if (!opts.out) {
    process.stderr.write('ts2doxy: pregen needs an output directory (--out <dir>)\n');
    return 2;
  }
  const outDir = path.resolve(opts.out);
  let files;
  try {
    files = resolveInputs(positional.length ? positional : ['.'], outDir);
  } catch (err) {
    process.stderr.write(`ts2doxy: ${err.message}\n`);
    return 1;
  }
  if (!files.length) {
    process.stderr.write('ts2doxy: no TypeScript or JavaScript files found\n');
    return 1;
  }

  const started = Date.now();
  const session = createSession(files[0], { ...opts, roots: files });
  const rootDir = session.project.rootDir;
  const programReady = Date.now();

  const log = (message) => {
    if (!opts.quiet) process.stderr.write(`${message}\n`);
  };
  const existing = countFiles(outDir);
  if (existing) {
    log(`ts2doxy: note: ${outDir} already holds ${existing} file(s);`
      + ' files whose sources are gone are not removed');
  }
  log(`ts2doxy: ${files.length} file(s), program built in ${formatSeconds(programReady - started)}`);

  let written = 0;
  let skipped = 0;
  let failed = 0;
  const totals = { total: 0, resolved: 0, external: 0, indirect: 0, unresolved: 0 };
  let drift = 0;

  for (const [index, file] of files.entries()) {
    const relative = path.relative(rootDir, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      // Outside the namespace root, so it has no place in the mirror tree.
      log(`ts2doxy: skipping ${file} (outside ${rootDir})`);
      skipped++;
      continue;
    }
    const target = path.join(outDir, relative);
    try {
      const result = session.translate(file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, result.text);
      written++;
      drift += result.stats.drift || 0;
      for (const key of Object.keys(totals)) {
        totals[key] += (result.stats.calls && result.stats.calls[key]) || 0;
      }
      if (opts.stats) {
        const record = opts.statsEdges ? result.stats : { ...result.stats, edges: undefined };
        fs.appendFileSync(opts.stats, `${JSON.stringify(record)}\n`);
      }
    } catch (err) {
      failed++;
      process.stderr.write(`ts2doxy: failed to translate ${file}: ${err.message}\n`);
      if (opts.strict) return 1;
    }
    if (!opts.quiet && (index + 1) % 100 === 0) {
      log(`ts2doxy: ${index + 1}/${files.length}`);
    }
  }

  const finished = Date.now();
  const internal = totals.total - totals.external;
  log('');
  log(`ts2doxy: wrote ${written} file(s) to ${outDir}`);
  if (skipped) log(`ts2doxy: skipped ${skipped} file(s) outside the root`);
  if (failed) log(`ts2doxy: ${failed} file(s) failed`);
  log(`ts2doxy: ${formatSeconds(finished - started)} total`
    + ` (${formatSeconds(programReady - started)} program,`
    + ` ${formatSeconds(finished - programReady)} translation,`
    + ` ${((finished - programReady) / Math.max(1, written)).toFixed(0)} ms/file)`);
  log(`ts2doxy: ${drift} declaration(s) off their source line`);
  if (totals.total) {
    log(`ts2doxy: ${totals.resolved}/${totals.total} calls resolved`
      + ` (${((totals.resolved / totals.total) * 100).toFixed(1)}% of all,`
      + ` ${((totals.resolved / Math.max(1, internal)) * 100).toFixed(1)}% of calls`
      + ' into the documented sources)');
  }
  log('');
  log('Point Doxygen at the generated tree, with no FILTER_PATTERNS:');
  log(`    INPUT = ${outDir}`);
  log('    EXTENSION_MAPPING = ts=C++ tsx=C++ mts=C++ cts=C++ js=C++ jsx=C++ mjs=C++ cjs=C++');
  log('    FILTER_SOURCE_FILES = NO');

  // Unlike the per-file filter -- which must never abort a documentation
  // build -- pre-generation is invoked directly, so a failure is reported.
  return failed ? 1 : 0;
}

module.exports = { collectFiles, countFiles, isSourceFile, resolveInputs, run };
