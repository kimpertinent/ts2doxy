'use strict';
/**
 * `ts2doxy report <stats.jsonl>` -- aggregate the per-file statistics that
 * `--stats` appends, one JSON object per translated file.
 *
 * The headline number is the call resolution rate: how many of the calls in
 * the sources became an edge Doxygen can draw.
 */

const fs = require('fs');

const DECLARATION_KINDS = [
  'classes', 'interfaces', 'enums', 'typedefs', 'functions', 'methods',
  'fields', 'variables', 'namespaces',
];

const CALL_KINDS = ['resolved', 'external', 'indirect', 'unresolved'];

/** Read a JSON-lines file, skipping blank and malformed lines. */
function readRecords(file) {
  const text = fs.readFileSync(file, 'utf8');
  const records = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

/** Sum the per-file records into one set of totals. */
function aggregate(records) {
  const totals = {
    files: 0,
    drift: 0,
    declarations: Object.fromEntries(DECLARATION_KINDS.map((k) => [k, 0])),
    calls: {
      total: 0, resolved: 0, external: 0, indirect: 0, unresolved: 0, recursive: 0,
    },
    samples: [],
    worstFiles: [],
  };
  // The same file can appear more than once (Doxygen may filter a file twice);
  // keep the last record for each.
  const byFile = new Map();
  for (const record of records) byFile.set(record.file || `#${byFile.size}`, record);

  for (const [file, record] of byFile) {
    totals.files++;
    totals.drift += record.drift || 0;
    for (const kind of DECLARATION_KINDS) {
      totals.declarations[kind] += record[kind] || 0;
    }
    const calls = record.calls || {};
    for (const key of Object.keys(totals.calls)) {
      totals.calls[key] += calls[key] || 0;
    }
    for (const sample of calls.samples || []) {
      if (totals.samples.length < 40) totals.samples.push(sample);
    }
    const unresolved = (calls.unresolved || 0) + (calls.indirect || 0);
    if (unresolved) totals.worstFiles.push({ file, unresolved, total: calls.total || 0 });
  }
  totals.worstFiles.sort((a, b) => b.unresolved - a.unresolved);
  return totals;
}

function percent(part, whole) {
  if (!whole) return '  n/a';
  return `${((part / whole) * 100).toFixed(1).padStart(5)}%`;
}

/** Render the aggregate as a plain-text report. */
function format(totals) {
  const lines = [];
  const { calls } = totals;
  const internal = calls.total - calls.external;

  lines.push('ts2doxy statistics');
  lines.push('');
  lines.push(`  files translated      ${String(totals.files).padStart(7)}`);
  lines.push(`  declarations off their source line ${String(totals.drift).padStart(3)}`);
  lines.push('');
  lines.push('  declarations');
  for (const kind of DECLARATION_KINDS) {
    const count = totals.declarations[kind];
    if (count) lines.push(`    ${kind.padEnd(18)}${String(count).padStart(7)}`);
  }
  lines.push('');
  lines.push('  calls');
  lines.push(`    seen              ${String(calls.total).padStart(7)}`);
  for (const kind of CALL_KINDS) {
    lines.push(
      `    ${kind.padEnd(18)}${String(calls[kind]).padStart(7)}  ${percent(calls[kind], calls.total)}`,
    );
  }
  if (calls.recursive) {
    lines.push(`    (of which recursive) ${String(calls.recursive).padStart(4)}`);
  }
  lines.push('');
  lines.push(`  resolution rate     ${percent(calls.resolved, calls.total)}  of all calls`);
  lines.push(
    `                      ${percent(calls.resolved, internal)}  of calls into the documented sources`,
  );
  lines.push('                             (external calls -- lib.d.ts, node_modules -- cannot');
  lines.push('                              become edges: Doxygen has no node for them)');
  lines.push('');
  lines.push('  "indirect" means the target resolved but is not a documented entity:');
  lines.push('  a function nested in a body, or a parameter holding a callback.');

  if (totals.samples.length) {
    lines.push('');
    lines.push('  unresolved call sites (sample)');
    for (const sample of [...new Set(totals.samples)].slice(0, 12)) {
      lines.push(`    ${sample}`);
    }
  }
  if (totals.worstFiles.length > 1) {
    lines.push('');
    lines.push('  files with the most unresolved calls');
    for (const entry of totals.worstFiles.slice(0, 8)) {
      lines.push(`    ${String(entry.unresolved).padStart(5)} / ${String(entry.total).padEnd(5)} ${entry.file}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function run(positional, opts = {}) {
  const [file] = positional;
  if (!file) {
    process.stderr.write('ts2doxy: report needs a statistics file (see --stats)\n');
    return 2;
  }
  if (!fs.existsSync(file)) {
    process.stderr.write(`ts2doxy: no such file: ${file}\n`);
    return 1;
  }
  const { records, skipped } = readRecords(file);
  if (skipped && !opts.quiet) {
    process.stderr.write(`ts2doxy: skipped ${skipped} malformed line(s)\n`);
  }
  if (!records.length) {
    process.stderr.write(`ts2doxy: no statistics in ${file}\n`);
    return 1;
  }
  process.stdout.write(format(aggregate(records)));
  return 0;
}

module.exports = { aggregate, format, readRecords, run };
