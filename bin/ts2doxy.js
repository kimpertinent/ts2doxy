#!/usr/bin/env node
'use strict';
/**
 * ts2doxy -- Doxygen input filter for TypeScript and JavaScript.
 *
 * Doxygen runs `ts2doxy <file>` and parses stdout instead of the file itself,
 * so stdout carries nothing but pseudo-code and every diagnostic goes to
 * stderr. A crash must not abort a documentation build either: unless
 * `--strict` is given, errors are reported on stderr and the file is skipped
 * with an empty translation.
 */

const fs = require('fs');
const path = require('path');

const USAGE = `ts2doxy -- Doxygen input filter for TypeScript/JavaScript

Usage:
  ts2doxy [options] <file>              translate one file to stdout (filter mode)
  ts2doxy pregen [options] <path...>    translate a whole tree into --out
  ts2doxy report [options] <stats.jsonl>  summarize collected statistics
  ts2doxy --help | --version

Options:
  -p, --project <tsconfig>   tsconfig.json to use (default: nearest one upwards)
  -r, --root <dir>           directory namespaces are derived from
                             (default: rootDir / the tsconfig directory)
  -n, --namespace-mode <m>   path (default) | flat | none
  -o, --out <dir>            output directory for pregen mode
      --whole-program        build the Program from the full tsconfig file list
                             instead of just the input file's import closure
      --no-implicit-ctors    do not synthesize constructors for classes that
                             declare none (loses "new Foo()" call edges)
      --share-declaration-lines
                             keep every declaration on its exact source line
                             even when several share one. Doxygen 1.9.8 then
                             invents call-graph edges between them, so this is
                             off by default
      --no-virtual           do not mark instance methods virtual
      --no-bodies            emit declarations only (no call-graph bodies)
      --list-unresolved      note unresolved call sites in the output as
                             comments (diagnostic aid)
      --stats <file>         append one JSON line of statistics per file
      --stats-edges          include the emitted call edges in --stats output
      --strict               exit non-zero on errors instead of skipping
  -q, --quiet                suppress warnings on stderr
`;

function parseArgs(argv) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '-p': case '--project': opts.project = next(); break;
      case '-r': case '--root': opts.root = next(); break;
      case '-n': case '--namespace-mode': opts.namespaceMode = next(); break;
      case '-o': case '--out': opts.out = next(); break;
      case '--whole-program': opts.wholeProgram = true; break;
      case '--no-implicit-ctors': opts.implicitCtors = false; break;
      case '--share-declaration-lines': opts.shareDeclarationLines = true; break;
      case '--no-virtual': opts.virtualMethods = false; break;
      case '--no-bodies': opts.emitBodies = false; break;
      case '--list-unresolved': opts.listUnresolved = true; break;
      case '--stats': opts.stats = next(); break;
      case '--stats-edges': opts.statsEdges = true; break;
      case '--strict': opts.strict = true; break;
      case '-q': case '--quiet': opts.quiet = true; break;
      default:
        if (arg.startsWith('-') && arg !== '-') {
          throw new Error(`unknown option: ${arg}`);
        }
        opts.positional.push(arg);
    }
  }
  return opts;
}

function warn(opts, message) {
  if (!opts.quiet) process.stderr.write(`ts2doxy: ${message}\n`);
}

function recordStats(opts, stats) {
  if (!opts.stats) return;
  try {
    // The edge list is large on real projects, so it is opt-in.
    const record = opts.statsEdges ? stats : { ...stats, edges: undefined };
    fs.appendFileSync(opts.stats, `${JSON.stringify(record)}\n`);
  } catch (err) {
    warn(opts, `could not write statistics: ${err.message}`);
  }
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`ts2doxy: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${require('../package.json').version}\n`);
    return 0;
  }

  const [first, ...rest] = opts.positional;
  if (first === 'pregen') return require('../src/pregen').run(rest, opts);
  if (first === 'report') return require('../src/report').run(rest, opts);

  if (!first) {
    process.stderr.write(USAGE);
    return 2;
  }
  return filterOne(first, opts);
}

function filterOne(file, opts) {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) {
    warn(opts, `no such file: ${file}`);
    return opts.strict ? 1 : 0;
  }
  try {
    const { filterFile } = require('../src/index');
    const result = filterFile(target, opts);
    process.stdout.write(result.text);
    recordStats(opts, result.stats);
    return 0;
  } catch (err) {
    warn(opts, `failed to translate ${file}: ${err && err.stack ? err.stack : err}`);
    if (opts.strict) return 1;
    // Emit nothing: Doxygen then sees an empty file rather than broken input.
    return 0;
  }
}

process.exitCode = main(process.argv.slice(2));
