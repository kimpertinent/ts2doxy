'use strict';
/**
 * Filter-mode cache: per-file filtering at the speed of pre-generation.
 *
 * Doxygen runs the filter about twice per input file, and every run used to
 * pay the full fixed cost again -- loading `typescript`, building a Program
 * and a type checker -- for 0.1 s of actual translation. With the cache, the
 * first run translates every file of the tsconfig in one pass (the same work
 * `ts2doxy pregen` does) and stores the results; every later run only checks
 * that nothing changed and prints the stored text.
 *
 * Doxygen still reads the original files, so the source browser keeps showing
 * the real TypeScript, as in plain filter mode.
 *
 * A lookup must not load `typescript`: that alone is 0.2 s, several times the
 * cost of starting node. Everything up to "the entry is fresh, print it" uses
 * plain `fs` calls; `typescript` is required only to build an entry.
 *
 * Layout, under `$XDG_CACHE_HOME/ts2doxy` (default `~/.cache/ts2doxy`):
 *
 *     <hash>/                one entry per tsconfig and set of output options
 *       key.json             the tsconfig and options the entry is for
 *       current              name of the generation that is in use
 *       lock/                exists while a process builds a generation
 *       g-<id>/manifest.json what the generation was built from
 *       g-<id>/<n>.txt       the translation of one file
 *       g-<id>/<n>.json      its statistics
 *
 * A generation is written completely before `current` is switched to it with
 * a rename, so a reader sees either the old generation or the new one, never a
 * half-written one. Parallel filter runs (Doxygen's NUM_PROC_THREADS) wait on
 * the lock while one of them builds.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { locateConfigFile } = require('./findup');

/** Bumped whenever the layout or the manifest format changes. */
const FORMAT = 1;

/** Options that change the translation; anything else does not split entries. */
const OUTPUT_OPTIONS = [
  'root', 'namespaceMode', 'namespaceName',
  'implicitCtors', 'virtualMethods', 'emitBodies', 'listUnresolved',
];

/** A lock older than this is assumed to belong to a process that died. */
const STALE_LOCK_MS = 10 * 60 * 1000;

/** How long a filter run waits for another one's build before giving up. */
const WAIT_LIMIT_MS = 15 * 60 * 1000;

const POLL_MS = 50;

/** Directory holding all cache entries. */
function cacheRoot() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'ts2doxy');
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Two 32-bit FNV-1a-style hashes, as 16 hex digits. Not `crypto`: loading that module alone costs more
 * than the rest of a cache hit. Collisions are harmless, since every entry
 * stores its full key and `lookup` compares it.
 */
function hash(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/**
 * The cache entry for `file`: `{dir, key}`, or null when there is no tsconfig
 * to key it on (a lone file outside any project is translated directly).
 */
function entryFor(file, opts, root = cacheRoot()) {
  const configPath = locateConfigFile(file, opts.project);
  if (!configPath || !fs.existsSync(configPath)) return null;
  const key = { format: FORMAT, config: path.resolve(configPath) };
  for (const name of OUTPUT_OPTIONS) {
    if (opts[name] !== undefined) key[name] = name === 'root' ? path.resolve(opts[name]) : opts[name];
  }
  const text = JSON.stringify(key);
  for (let n = 0; ; n++) {
    const dir = path.join(root, `${hash(text)}${n ? `-${n}` : ''}`);
    let stored = null;
    try {
      stored = fs.readFileSync(path.join(dir, 'key.json'), 'utf8');
    } catch {
      // a new entry
    }
    if (stored === null) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Via a rename, so a parallel run never reads a half-written key.
      const tmp = path.join(dir, `key.${process.pid}.tmp`);
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, path.join(dir, 'key.json'));
      return { dir, key: text };
    }
    if (stored === text) return { dir, key: text };
  }
}

/** `[mtimeMs, size]` of a file, or null when it is gone. */
function fingerprint(file) {
  try {
    const st = fs.statSync(file);
    return [st.mtimeMs, st.size];
  } catch {
    return null;
  }
}

/** Is a directory entry one that can add or remove project files? */
function listed(entry) {
  return !entry.name.startsWith('.') && entry.name !== 'node_modules';
}

/** The entries of a directory that matter for the project's file list. */
function listing(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(listed)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
  } catch {
    return null;
  }
}

function sameFingerprint(a, b) {
  return a === null ? b === null : b !== null && a[0] === b[0] && a[1] === b[1];
}

/**
 * Is the generation described by `manifest` still what a fresh translation
 * would produce? True when no file that went into it changed, and no directory
 * the tsconfig globs over gained or lost an entry.
 */
function isFresh(manifest) {
  for (const [file, mtimeMs, size] of manifest.inputs) {
    if (!sameFingerprint(mtimeMs === null ? null : [mtimeMs, size], fingerprint(file))) return false;
  }
  for (const [dir, mtimeMs, entries] of manifest.dirs) {
    const now = fingerprint(dir);
    if (now && now[0] === mtimeMs) continue;
    // The directory was touched; that matters only if its listing changed
    // (Doxygen writing its output next to the sources must not invalidate).
    const current = listing(dir);
    if (!current || current.join('\n') !== entries.join('\n')) return false;
  }
  return true;
}

/** The manifest of the generation in use, or null. */
function readCurrent(dir) {
  try {
    const gen = fs.readFileSync(path.join(dir, 'current'), 'utf8').trim();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, gen, 'manifest.json'), 'utf8'));
    if (manifest.format !== FORMAT) return null;
    return { gen: path.join(dir, gen), manifest };
  } catch {
    return null;
  }
}

/**
 * Serve `file` from a fresh generation.
 * @returns {{text, stats}|null} the stored translation; null when the
 *   generation does not hold one (the file is not in the tsconfig's file
 *   list, or failed to translate) and the caller has to translate directly
 */
function serve(current, file) {
  const record = current.manifest.files[file];
  if (!record || record.failed) return null;
  const text = fs.readFileSync(path.join(current.gen, `${record.id}.txt`), 'utf8');
  const stats = JSON.parse(fs.readFileSync(path.join(current.gen, `${record.id}.json`), 'utf8'));
  return { text, stats };
}

/** Try to take the build lock. True on success. */
function tryLock(dir) {
  const lock = path.join(dir, 'lock');
  try {
    fs.mkdirSync(lock);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (!isStale(lock)) return false;
    fs.rmSync(lock, { recursive: true, force: true });
    try {
      fs.mkdirSync(lock);
    } catch (again) {
      if (again.code === 'EEXIST') return false;
      throw again;
    }
  }
  fs.writeFileSync(path.join(lock, 'owner'), JSON.stringify({ pid: process.pid, host: os.hostname() }));
  return true;
}

/** Was the lock left behind by a process that is gone? */
function isStale(lock) {
  let st;
  try {
    st = fs.statSync(lock);
  } catch {
    return false; // released meanwhile; the next mkdir decides
  }
  if (Date.now() - st.mtimeMs > STALE_LOCK_MS) return true;
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner'), 'utf8'));
    if (owner.host !== os.hostname()) return false;
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    // ESRCH: the owner is dead. A missing or half-written owner file means the
    // owner is between mkdir and writing it, which is not stale.
    return err.code === 'ESRCH';
  }
}

function unlock(dir) {
  fs.rmSync(path.join(dir, 'lock'), { recursive: true, force: true });
}

/**
 * Translate every file of the project into a new generation and make it
 * current. Runs under the lock.
 */
function build(dir, file, opts) {
  const ts = require('typescript');
  const { resolveProject, createProgram } = require('./project');
  const { Session } = require('./index');

  // Fingerprints are taken *before* a file is read: a file that changes while
  // the build runs then no longer matches, and the next run rebuilds.
  const inputs = new Map();
  const note = (f) => {
    const resolved = path.resolve(f);
    if (!inputs.has(resolved)) inputs.set(resolved, fingerprint(resolved));
  };
  const configPath = locateConfigFile(file, opts.project);
  note(configPath);
  const project = resolveProject(file, opts);
  for (const f of project.configFiles) note(f);
  // The namespace of `--namespace-mode single` comes from this package.json.
  note(path.join(project.configDir, 'package.json'));
  // And the translation from our own sources and the TypeScript version.
  for (const f of fs.readdirSync(__dirname)) note(path.join(__dirname, f));
  note(require.resolve('typescript/package.json'));

  const host = ts.createCompilerHost(project.options, /* setParentNodes */ true);
  const readFile = host.readFile.bind(host);
  host.readFile = (f) => {
    note(f);
    return readFile(f);
  };
  const program = createProgram(project.fileNames, project.options, host);
  const session = new Session(program, project, opts);

  const gen = `g-${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const genDir = path.join(dir, gen);
  fs.mkdirSync(genDir);
  const files = {};
  let id = 0;
  for (const name of project.fileNames) {
    const resolved = path.resolve(name);
    if (/[\\/]node_modules[\\/]/.test(resolved)) continue;
    const record = { id: id++ };
    try {
      const result = session.translate(resolved);
      fs.writeFileSync(path.join(genDir, `${record.id}.txt`), result.text);
      fs.writeFileSync(path.join(genDir, `${record.id}.json`), JSON.stringify(result.stats));
    } catch (err) {
      record.failed = String(err && err.message);
    }
    files[resolved] = record;
  }

  const manifest = {
    format: FORMAT,
    inputs: [...inputs].map(([f, fp]) => [f, fp ? fp[0] : null, fp ? fp[1] : null]),
    dirs: watchedDirectories(project).map((d) => [d, (fingerprint(d) || [null])[0], listing(d) || []]),
    files,
  };
  fs.writeFileSync(path.join(genDir, 'manifest.json'), JSON.stringify(manifest));
  const pointer = path.join(dir, `current.${process.pid}.tmp`);
  fs.writeFileSync(pointer, gen);
  fs.renameSync(pointer, path.join(dir, 'current'));

  // Older generations are no longer reachable. A reader that picked one up
  // just before the switch and finds it gone retries (see `lookup`).
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('g-') && entry !== gen) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  return { gen: genDir, manifest };
}

/**
 * Directories whose listing decides the project's file list: every directory
 * the tsconfig's `include` globs over, walked recursively (skipping dot
 * directories and node_modules, as TypeScript does). A file added anywhere
 * below changes one of their listings -- also in a directory that held no
 * project file so far.
 */
function watchedDirectories(project) {
  const dirs = new Set();
  const walk = (dir, recursive) => {
    if (dirs.has(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    dirs.add(dir);
    if (!recursive) return;
    for (const e of entries) {
      if (e.isDirectory() && listed(e)) walk(path.join(dir, e.name), true);
    }
  };
  for (const [dir, flags] of Object.entries(project.wildcardDirectories)) {
    walk(path.resolve(dir), (flags & 1) !== 0); // ts.WatchDirectoryFlags.Recursive
  }
  return [...dirs].sort();
}

/**
 * The cached translation of `file`, building or rebuilding the cache entry
 * when needed.
 *
 * @returns {{text, stats}|null} null when the cache does not apply: no
 *   tsconfig, a file outside the tsconfig's file list, a file that failed in
 *   the build. The caller then translates the file directly, which reproduces
 *   plain filter mode exactly, error messages included.
 */
function lookup(file, opts = {}, root = cacheRoot()) {
  const target = path.resolve(file);
  const entry = entryFor(target, opts, root);
  if (!entry) return null;
  const { dir } = entry;

  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const current = readCurrent(dir);
    if (current && isFresh(current.manifest)) {
      try {
        return serve(current, target);
      } catch (err) {
        // The generation was replaced under us; look again.
        if (err.code !== 'ENOENT' || attempt > 3) throw err;
        continue;
      }
    }
    if (tryLock(dir)) {
      try {
        // Another process may have finished a build between our check and
        // taking the lock.
        const again = readCurrent(dir);
        if (again && isFresh(again.manifest)) return serve(again, target);
        return serve(build(dir, target, opts), target);
      } finally {
        unlock(dir);
      }
    }
    if (Date.now() - started > WAIT_LIMIT_MS) return null;
    sleep(POLL_MS);
  }
}

module.exports = { FORMAT, cacheRoot, entryFor, isFresh, lookup, readCurrent };
