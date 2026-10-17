#!/usr/bin/env node
'use strict';
/**
 * Check a Doxygen run against the TypeScript it came from.
 *
 * Reads `extends`/`implements` out of the TypeScript sources and the
 * `<basecompoundref>` entries out of Doxygen's XML, and diffs the two. Used
 * for the real-project test in the README; works on any project.
 *
 *   node test/verify-project.js <source-dir> <doxygen-xml-dir>
 *
 * Exits non-zero if an inheritance edge is missing from the documentation or
 * if Doxygen reports one the sources do not have.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `extends` / `implements` as written in the TypeScript, by simple name. */
function expectedEdges(dir) {
  const edges = new Map();
  for (const file of sourceFiles(dir)) {
    const sf = ts.createSourceFile(
      file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true,
    );
    const visit = (node) => {
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name) {
        const bases = [];
        for (const clause of node.heritageClauses || []) {
          for (const type of clause.types) {
            const expression = type.expression;
            bases.push(ts.isPropertyAccessExpression(expression)
              ? expression.name.getText()
              : expression.getText());
          }
        }
        if (bases.length) {
          const key = node.name.text;
          if (!edges.has(key)) edges.set(key, new Set());
          for (const base of bases) edges.get(key).add(base);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return edges;
}

/** The last name component, with template arguments dropped. */
function simpleName(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/<.*/, '')
    .trim()
    .split('::')
    .pop();
}

/** Base classes Doxygen recorded, by simple name. */
function actualEdges(xmlDir) {
  const edges = new Map();
  for (const file of fs.readdirSync(xmlDir)) {
    if (!file.startsWith('class') || !file.endsWith('.xml')) continue;
    const xml = fs.readFileSync(path.join(xmlDir, file), 'utf8');
    const name = /<compoundname>([^<]*)<\/compoundname>/.exec(xml);
    if (!name) continue;
    const cls = simpleName(name[1]);
    const bases = [...xml.matchAll(/<basecompoundref[^>]*>([^<]*)<\/basecompoundref>/g)]
      .map((match) => simpleName(match[1]));
    if (!bases.length) continue;
    if (!edges.has(cls)) edges.set(cls, new Set());
    for (const base of bases) edges.get(cls).add(base);
  }
  return edges;
}

function main([sourceDir, xmlDir]) {
  if (!sourceDir || !xmlDir) {
    process.stderr.write('usage: verify-project.js <source-dir> <doxygen-xml-dir>\n');
    return 2;
  }
  const expected = expectedEdges(path.resolve(sourceDir));
  const actual = actualEdges(path.resolve(xmlDir));

  const missing = [];
  const invented = [];
  let matched = 0;
  for (const [cls, bases] of expected) {
    const got = actual.get(cls) || new Set();
    for (const base of bases) {
      if (got.has(base)) matched++;
      else missing.push(`${cls} -> ${base}`);
    }
  }
  for (const [cls, bases] of actual) {
    const want = expected.get(cls) || new Set();
    for (const base of bases) if (!want.has(base)) invented.push(`${cls} -> ${base}`);
  }

  const total = [...expected.values()].reduce((sum, set) => sum + set.size, 0);
  process.stdout.write(`inheritance edges in the TypeScript source: ${total}\n`);
  process.stdout.write(`  matched in the documentation: ${matched}`
    + ` (${total ? ((matched / total) * 100).toFixed(1) : '0.0'}%)\n`);
  process.stdout.write(`  missing: ${missing.length}\n`);
  for (const edge of missing.slice(0, 20)) process.stdout.write(`    ${edge}\n`);
  process.stdout.write(`  not in the sources: ${invented.length}\n`);
  for (const edge of invented.slice(0, 20)) process.stdout.write(`    ${edge}\n`);
  return missing.length || invented.length ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
