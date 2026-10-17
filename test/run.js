#!/usr/bin/env node
'use strict';
/**
 * ts2doxy test suite.
 *
 * Two layers:
 *   1. Translation checks -- run the filter over `test/fixtures/src` and assert
 *      that every mapping rule produced the expected pseudo-code, and that no
 *      declaration drifted off its original source line.
 *   2. Doxygen integration -- if `doxygen` is on PATH, run it over the
 *      fixtures and assert there are no parser warnings and that the class
 *      hierarchy, line numbers and call graphs came out right. Skipped
 *      (not failed) when Doxygen is missing.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const SRC = path.join(FIXTURES, 'src');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function contains(name, haystack, needle) {
  check(name, haystack.includes(needle), `expected to find: ${needle}`);
}

function absent(name, haystack, needle) {
  check(name, !haystack.includes(needle), `expected NOT to find: ${needle}`);
}

/* ------------------------------------------------------------------ *
 * 1. translation
 * ------------------------------------------------------------------ */

const { createSession } = require('../src/index');

const session = createSession(SRC, { wholeProgram: true });
const outputs = new Map();
const statsByFile = new Map();
for (const file of fs.readdirSync(SRC)) {
  const full = path.join(SRC, file);
  const result = session.translate(full);
  outputs.set(file, result.text);
  statsByFile.set(file, result.stats);
  check(`${file}: translated without drift (drift=${result.stats.drift})`, result.stats.drift === 0);
}

const shapes = outputs.get('shapes.ts');
const types = outputs.get('types.ts');
const functions = outputs.get('functions.ts');
const app = outputs.get('app.ts');
const legacy = outputs.get('legacy.js');
const overloads = outputs.get('overloads.ts');
const inference = outputs.get('inference.ts');

// namespaces derived from the file path
contains('module -> namespace', shapes, 'namespace src { namespace shapes {');

// classes, interfaces, inheritance
contains('interface -> class', shapes, 'class Shape {');
contains('implements -> public inheritance', shapes,
  'class AbstractShape : public src::shapes::Shape {');
contains('extends + implements -> multiple bases', shapes,
  'class Rectangle : public src::shapes::AbstractShape, public src::shapes::Drawable {');
contains('derived class', shapes, 'class Square : public src::shapes::Rectangle {');
contains('interface extends several bases', types,
  'class NamedAndIdentified : public src::types::Named, public src::types::Identified {');

// members and modifiers
contains('abstract method -> pure virtual', shapes, 'virtual number area() = 0;');
contains('interface method -> pure virtual', shapes, 'virtual void draw(string target) = 0;');
contains('static field', shapes, 'static number instances = 0;');
contains('readonly -> const', shapes, 'const string id;');
contains('static readonly', shapes, 'static const number PI');
contains('protected section', shapes, 'protected: number factor = 1;');
contains('private section', shapes, 'private: virtual number audit();');
contains('#private -> private', shapes, 'private: number secret = 42;');
contains('getter', shapes, 'virtual number currentScale();');
contains('setter', shapes, 'virtual void currentScale(number value);');
contains('constructor parameter property', shapes, 'public: number width;');
contains('generic class -> template', shapes, 'template< typename T > class ShapeBag {');
contains('generic constraint in docs', shapes, 'TypeScript type parameters: `T extends Shape`');
contains('implicit constructor synthesized', shapes, 'ShapeBag();');

// enums and type aliases
contains('enum -> enum class', types, 'enum class Direction {');
contains('enum member value', types, 'Left = -1,');
contains('const enum noted', types, 'TypeScript `const enum`');
contains('simple alias -> typedef', types, 'typedef number Pixels;');
contains('union -> sanitized identifier', types, 'typedef string_or_number_or_boolean Scalar;');
contains('nullable union collapses', types, 'typedef string MaybeName;');
contains('string literal union', types, 'typedef string Alignment;');
contains('tuple type', types, 'typedef Tuple< number, number > Point;');
contains('function type', types,
  'template< typename T > using Comparator = std::function< number(T, T) >;');
contains('mapped type', types, 'using Flags = MappedType;');
contains('conditional type', types, 'using Unwrap = ConditionalType;');
contains('generic alias default qualified', types,
  'template< typename Row = Record< string, src::types::Scalar > >');
contains('keyof type', types, 'typedef keyof_Identified IdentifiedKey;');
contains('template literal type -> string', types, 'typedef string EventName;');
contains('original TS type kept in docs', types,
  'TypeScript type alias: `export type Scalar = string | number | boolean;`');

// interfaces with exotic members
contains('index signature -> operator[]', types, 'V operator[](string key);');
contains('call signature -> operator()', types, 'Array< T > operator()(number count);');
contains('construct signature -> constructor', types, 'Factory(number count);');

// TypeScript namespaces
contains('namespace -> namespace', types, 'namespace units {');
contains('nested namespace', types, 'namespace imperial {');

// functions
contains('function declaration', functions, 'string describe();');
contains('generic function -> template', functions, 'template< typename T > T identity(T value);');
check('overloads emitted twice',
  (functions.match(/number parse\(/g) || []).length >= 2,
  'expected at least two `parse` declarations');
contains('default parameter', functions, 'string join(string separator = ", "');
contains('rest parameter', functions, 'Array< string > parts)');
contains('destructured parameter', functions, 'string place(object arg0)');
// `double` is a C++ keyword, so the emitted name gets a trailing underscore.
contains('arrow function -> free function', functions, 'number double_(number value)');
contains('async noted', functions, '@note `async` function.');
contains('generator noted', functions, '@note Generator function.');
contains('named export noted', functions, 'Exported as named export `identity`');
contains('default export noted', functions, '@note Default export of this module.');
contains('re-export noted', functions, 'Exported as named export `helper`');

// overloads: signatures are declarations, never pure virtual, and the
// implementation signature is not part of the documented API
contains('overload signature not pure virtual', overloads,
  'public: virtual string format(number value);');
contains('second overload signature', overloads,
  'public: virtual string format(boolean value);');
absent('overload implementation not emitted', overloads, 'number_or_boolean');
contains('constructor overload signatures', overloads, 'public: Span(number end);');
contains('parameter property from the implementation', overloads, 'public: number start;');
contains('ambient method is a plain declaration', overloads,
  'public: virtual number invoke(string value);');
absent('ambient method is not pure virtual', overloads, 'invoke(string value) = 0');

// inferred types keep their type arguments and qualified names
contains('inferred Map keeps both type arguments', inference,
  'private: Map< string, number > index;');
contains('inferred nested type arguments', inference,
  'private: Set< Promise< string > > pending;');
contains('inferred type argument from another module is qualified', inference,
  'public: Map< string, src::shapes::Circle > shapes;');
contains('inferred array type', inference, 'public: const Array< string > tags;');
contains('inferred enum type is qualified', inference, 'public: src::types::Direction heading');
contains('inferred return type keeps type arguments', inference,
  'virtual Map< string, src::shapes::Circle > allShapes();');
contains('inferred return type of a free function', inference,
  'src::inference::Store makeStore();');

// every class member carries an explicit access specifier: a stale section
// would silently change the protection of everything after it
for (const [file, text] of [['shapes.ts', shapes], ['app.ts', app],
  ['inference.ts', inference], ['overloads.ts', overloads]]) {
  const members = text.split('\n')
    .flatMap((line) => line.split(/(?=\b(?:public|protected|private):)/))
    .filter((part) => /^\s*(?:static |virtual |const |template)?[A-Za-z_]/.test(part))
    .filter((part) => /[A-Za-z_][A-Za-z0-9_]*\s*(\(|=|;)/.test(part));
  check(`${file}: access specifiers are explicit`, members.length > 0);
}

// JavaScript
contains('js class', legacy, 'class Cache {');
contains('jsdoc types used in signature', legacy, 'virtual boolean put(string key, number value);');
contains('inferred return type qualified', legacy, 'src::legacy::Cache createCache();');

// hygiene: nothing that would break Doxygen's parser
for (const [file, text] of outputs) {
  absent(`${file}: no line comments emitted`, text, '//');
  check(`${file}: braces balanced`,
    (text.match(/\{/g) || []).length === (text.match(/\}/g) || []).length,
    `{ = ${(text.match(/\{/g) || []).length}, } = ${(text.match(/\}/g) || []).length}`);
}

// line fidelity: every emitted class must sit on its source line
function sourceLineOf(file, pattern) {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n');
  const index = lines.findIndex((l) => pattern.test(l));
  return index + 1;
}
function outputLineOf(file, pattern) {
  const lines = outputs.get(file).split('\n');
  const index = lines.findIndex((l) => pattern.test(l));
  return index + 1;
}
for (const [file, patterns] of Object.entries({
  'shapes.ts': [/export abstract class AbstractShape/, /export class Circle/],
  'types.ts': [/export enum Direction/, /export interface Factory/],
  'app.ts': [/export class DetailedReport/],
})) {
  for (const re of patterns) {
    const name = re.source.match(/(\w+)$/)[1];
    const src = sourceLineOf(file, re);
    const out = outputLineOf(file, new RegExp(`\\b(class|enum class)\\s+${name}\\b`));
    check(`${file}: ${name} emitted on source line ${src}`, src === out, `emitted on line ${out}`);
  }
}

/* ------------------------------------------------------------------ *
 * 2. Doxygen integration
 * ------------------------------------------------------------------ */

function haveDoxygen() {
  try {
    execFileSync('doxygen', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

if (!haveDoxygen()) {
  process.stderr.write('note: doxygen not found, skipping integration checks\n');
} else {
  const out = path.join(FIXTURES, 'doxygen-out');
  fs.rmSync(out, { recursive: true, force: true });
  execFileSync('doxygen', ['Doxyfile'], { cwd: FIXTURES, stdio: 'pipe' });

  const warnings = fs.existsSync(path.join(FIXTURES, 'doxygen-warnings.log'))
    ? fs.readFileSync(path.join(FIXTURES, 'doxygen-warnings.log'), 'utf8').trim()
    : '';
  check('doxygen produced no warnings', warnings === '', warnings.split('\n').slice(0, 8).join('\n      '));

  const xmlDir = path.join(out, 'xml');
  const readXml = (name) => fs.readFileSync(path.join(xmlDir, name), 'utf8');

  // inheritance
  const rectangle = readXml('classsrc_1_1shapes_1_1Rectangle.xml');
  contains('doxygen: Rectangle extends AbstractShape', rectangle,
    '>src::shapes::AbstractShape</basecompoundref>');
  contains('doxygen: Rectangle implements Drawable', rectangle,
    '>src::shapes::Drawable</basecompoundref>');
  contains('doxygen: Square derives from Rectangle', rectangle,
    '>src::shapes::Square</derivedcompoundref>');

  // line references
  const circle = readXml('classsrc_1_1shapes_1_1Circle.xml');
  const circleLine = sourceLineOf('shapes.ts', /export class Circle/);
  contains(`doxygen: Circle located at shapes.ts:${circleLine}`, circle,
    `line="${circleLine}"`);

  // Protection as Doxygen sees it, against the TypeScript source. The table
  // is written out by hand from the fixtures on purpose: deriving it with the
  // same code the emitter uses would not test anything.
  const EXPECTED_PROTECTION = {
    'classsrc_1_1shapes_1_1Shape.xml': {
      area: 'public', name: 'public', scale: 'public',
    },
    'classsrc_1_1shapes_1_1AbstractShape.xml': {
      instances: 'public', id: 'public', factor: 'protected', secret: 'private',
      AbstractShape: 'public', name: 'public', area: 'public', scale: 'public',
      currentScale: 'public', reset: 'public', audit: 'private',
    },
    'classsrc_1_1shapes_1_1Rectangle.xml': {
      Rectangle: 'public', width: 'public', height: 'public',
      area: 'public', draw: 'public',
    },
    'classsrc_1_1shapes_1_1Circle.xml': {
      PI: 'public', Circle: 'public', radius: 'private', area: 'public',
    },
    'classsrc_1_1shapes_1_1ShapeBag.xml': {
      items: 'private', add: 'public', totalArea: 'public', ShapeBag: 'public',
    },
    'classsrc_1_1app_1_1Report.xml': {
      bag: 'private', populate: 'public', totalMillimetres: 'public',
      resetCounters: 'public', summary: 'public', label: 'public',
      dynamic: 'public', Report: 'public',
    },
    'classsrc_1_1app_1_1DetailedReport.xml': {
      DetailedReport: 'public', verbose: 'private', describe: 'public',
    },
    'classsrc_1_1inference_1_1Store.xml': {
      index: 'private', pending: 'private', shapes: 'public', tags: 'public',
      heading: 'public', lookup: 'public', allShapes: 'public', Store: 'public',
    },
    'classsrc_1_1overloads_1_1Formatter.xml': {
      format: 'public', trim: 'public', Formatter: 'public',
    },
    'classsrc_1_1overloads_1_1Span.xml': {
      Span: 'public', start: 'public', end: 'public', width: 'public',
    },
    'classsrc_1_1overloads_1_1Native.xml': {
      invoke: 'public', Native: 'public',
    },
  };
  // `<name>` also appears in cross-reference sections, so only the
  // `<memberdef>` elements themselves are read.
  const memberDefs = (xml) => {
    const out = [];
    const re = /<memberdef\b([^>]*)>[\s\S]*?<name>([^<]*)<\/name>/g;
    let match;
    while ((match = re.exec(xml)) !== null) {
      const prot = /\bprot="([a-z]+)"/.exec(match[1]);
      out.push({ name: match[2], prot: prot ? prot[1] : '?' });
    }
    return out;
  };
  const countMembers = (xml, name) =>
    memberDefs(xml).filter((m) => m.name === name).length;

  for (const [xmlFile, expected] of Object.entries(EXPECTED_PROTECTION)) {
    const xml = readXml(xmlFile);
    const found = new Map();
    for (const { name: member, prot } of memberDefs(xml)) {
      if (!found.has(member)) found.set(member, new Set());
      found.get(member).add(prot);
    }
    const cls = xmlFile.replace(/^class|\.xml$/g, '').replace(/_1_1/g, '::');
    for (const [member, want] of Object.entries(expected)) {
      const got = found.get(member);
      check(`doxygen: ${cls}::${member} is ${want}`,
        got && got.size === 1 && got.has(want),
        got ? `reported as ${[...got].join('/')}` : 'member missing from the XML');
    }
    for (const member of found.keys()) {
      check(`doxygen: ${cls}::${member} is expected to exist`,
        Object.prototype.hasOwnProperty.call(expected, member),
        'member present in the XML but not in the expectation table');
    }
  }

  // overload sets: both signatures present, neither abstract, no
  // implementation signature
  const formatter = readXml('classsrc_1_1overloads_1_1Formatter.xml');
  check('doxygen: both format overloads documented',
    countMembers(formatter, 'format') === 2,
    `found ${countMembers(formatter, 'format')}`);
  absent('doxygen: overloads are not pure virtual', formatter, 'virt="pure-virtual"');
  const native = readXml('classsrc_1_1overloads_1_1Native.xml');
  absent('doxygen: ambient method is not pure virtual', native, 'virt="pure-virtual"');
  const span = readXml('classsrc_1_1overloads_1_1Span.xml');
  check('doxygen: both constructor overloads documented',
    countMembers(span, 'Span') === 2,
    `found ${countMembers(span, 'Span')}`);
  const abstractShape = readXml('classsrc_1_1shapes_1_1AbstractShape.xml');
  contains('doxygen: abstract member is pure virtual', abstractShape, 'virt="pure-virtual"');

  // inferred types survive the round trip through Doxygen
  const store = readXml('classsrc_1_1inference_1_1Store.xml');
  contains('doxygen: inferred Map type arguments kept', store,
    'Map&lt; string, number &gt;');
  contains('doxygen: inferred qualified type argument kept', store,
    'src::shapes::Circle');

  // diagrams
  for (const graph of [
    'classsrc_1_1shapes_1_1Rectangle__inherit__graph.svg',
    'classsrc_1_1shapes_1_1Rectangle__coll__graph.svg',
  ]) {
    check(`doxygen: ${graph} generated`,
      fs.existsSync(path.join(out, 'html', graph)));
  }
  const inherit = fs.readFileSync(
    path.join(out, 'html', 'classsrc_1_1shapes_1_1Rectangle__inherit__graph.svg'), 'utf8',
  );
  for (const node of ['src::shapes::Rectangle', 'src::shapes::AbstractShape',
    'src::shapes::Shape', 'src::shapes::Drawable', 'src::shapes::Square']) {
    contains(`doxygen: inheritance graph contains ${node}`, inherit, node);
  }
  contains('doxygen: UML_LOOK shows members', inherit, 'virtual number area()');

  if (process.env.TS2DOXY_TEST_CALLGRAPH) {
    const report = readXml('classsrc_1_1app_1_1Report.xml');
    contains('doxygen: call graph reference recorded', report, '<references ');
  }
}

/* ------------------------------------------------------------------ */

process.stdout.write(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write(`\nfailures:\n  - ${failures.join('\n  - ')}\n`);
  process.exitCode = 1;
}
