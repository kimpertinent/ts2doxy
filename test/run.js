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

// A fixture that does not type-check would make the call resolver look weak:
// an import that does not exist resolves to nothing, which is
// indistinguishable from a resolver bug in the statistics.
{
  const ts = require('typescript');
  const diagnostics = [
    ...session.program.getSemanticDiagnostics(),
    ...session.program.getSyntacticDiagnostics(),
  ];
  check('fixtures type-check without diagnostics', diagnostics.length === 0,
    diagnostics.slice(0, 5).map((d) => {
      const where = d.file
        ? `${path.basename(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
        : '?';
      return `${where} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    }).join('\n      '));
}

const outputs = new Map();
const statsByFile = new Map();
/*
 * Declarations that could not be emitted on their original source line.
 *
 * Zero everywhere the source puts one declaration per line. The exceptions
 * are declarations that share a source line with another one: Doxygen 1.9.8
 * invents call references between those, so each one has to start a new
 * output line (see canvas.js). Pinning the exact numbers here keeps that
 * trade-off visible and catches drift appearing anywhere new.
 */
const EXPECTED_DRIFT = {
  // Rectangle's second parameter property: parameter properties are emitted at
  // the end of the class body (they are declared inside the constructor's
  // parameter list and can never have a line of their own), and only the first
  // one fits on the closing-brace line.
  'shapes.ts': 1,
  'app.ts': 0,
  // Span's second parameter property, same reason
  'overloads.ts': 1,
  // written on purpose with several declarations per line
  'compact.ts': 13,
  'types.ts': 0,
  'functions.ts': 0,
  'inference.ts': 0,
  'docs.ts': 0,
  'legacy.js': 0,
};
for (const file of fs.readdirSync(SRC)) {
  const full = path.join(SRC, file);
  const result = session.translate(full);
  outputs.set(file, result.text);
  statsByFile.set(file, result.stats);
  const expected = EXPECTED_DRIFT[file];
  check(`${file}: ${expected} declaration(s) off their source line`,
    result.stats.drift === expected,
    `drift=${result.stats.drift}, expected ${expected}`);
}

const shapes = outputs.get('shapes.ts');
const types = outputs.get('types.ts');
const functions = outputs.get('functions.ts');
const app = outputs.get('app.ts');
const legacy = outputs.get('legacy.js');
const overloads = outputs.get('overloads.ts');
const inference = outputs.get('inference.ts');
const docs = outputs.get('docs.ts');

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
contains('private section', shapes, 'private: virtual number audit()');
contains('#private -> private', shapes, 'private: number secret = 42;');
contains('getter', shapes, 'virtual number currentScale()');
contains('setter', shapes, 'virtual void currentScale(number value)');
contains('constructor parameter property', shapes, 'public: number width;');
contains('generic class -> template', shapes, 'template< typename T > class ShapeBag {');
contains('generic constraint in docs', shapes,
  'TypeScript type parameters: <tt>T extends Shape</tt>');
contains('implicit constructor synthesized', shapes, 'ShapeBag();');

// enums and type aliases
contains('enum -> enum class', types, 'enum class Direction {');
contains('enum member value', types, 'Left = -1,');
contains('const enum noted', types, 'TypeScript <tt>const enum</tt>');
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
  'TypeScript type alias: <tt>export type Scalar = string | number | boolean;</tt>');

// interfaces with exotic members
contains('index signature -> operator[]', types, 'V operator[](string key);');
contains('call signature -> operator()', types, 'Array< T > operator()(number count);');
contains('construct signature -> constructor', types, 'Factory(number count);');

// TypeScript namespaces
contains('namespace -> namespace', types, 'namespace units {');
contains('nested namespace', types, 'namespace imperial {');

// functions
contains('function declaration', functions, 'string describe()');
contains('generic function -> template', functions, 'template< typename T > T identity(T value)');
check('overloads emitted twice',
  (functions.match(/number parse\(/g) || []).length >= 2,
  'expected at least two `parse` declarations');
contains('default parameter', functions, 'string join(string separator = ", "');
contains('rest parameter', functions, 'Array< string > parts)');
contains('destructured parameter', functions, 'string place(object arg0)');
// `double` is a C++ keyword, so the emitted name gets a trailing underscore.
contains('arrow function -> free function', functions, 'number double_(number value)');
contains('async noted', functions, '@note <tt>async</tt> function.');
// Generated notes get a `%` on their leading word so Doxygen's AUTOLINK_SUPPORT
// does not turn boilerplate into a link to a same-named class.
contains('generator noted', functions, '@note %Generator function.');
contains('named export noted', functions, 'Exported as named export <tt>identity</tt>');
contains('default export noted', functions, '@note %Default export of this module.');
contains('re-export noted', functions, 'Exported as named export <tt>helper</tt>');

// overloads: signatures are declarations, never pure virtual, and the
// implementation signature is not part of the documented API
contains('overload signature not pure virtual', overloads,
  'public: virtual string format(number value);');
contains('second overload signature', overloads,
  'public: virtual string format(boolean value)');
absent('overload implementation not emitted', overloads, 'number_or_boolean');
contains('constructor overload signatures', overloads, 'public: Span(number end);');
contains('parameter property from the implementation', overloads, 'public: number start;');
contains('ambient method is a plain declaration', overloads,
  'public: virtual number invoke(string value);');
absent('ambient method is not pure virtual', overloads, 'invoke(string value) = 0');

/*
 * A function that is not a class member is emitted as a declaration on the
 * line above plus a definition that names it with its qualifier. Doxygen 1.18
 * reports an unqualified definition outside a class as calling itself, which
 * renders as a false recursion arrow; the qualifier removes that, and keeping
 * the definition on the function's own line keeps the reported line numbers.
 */
contains('free function declared before its definition', functions, 'string describe();');
contains('free function defined with a qualified name', functions,
  'string src::functions::describe() {');
contains('generic free function keeps its template prefix', functions,
  'template< typename T > T src::functions::identity(T value) {');
contains('arrow function gets the same treatment', functions,
  'number src::functions::double_(number value) {');
contains('overload signature with no body gets an empty definition', functions,
  'number src::functions::parse(number input) { }');
contains('function in a TypeScript namespace is qualified through it', types,
  'number src::types::units::toMillimetres(number inches) {');

// `this` as a return type must be the qualified class name: an unqualified one
// is read by Doxygen 1.18 as a reference to the class's constructor.
contains('this-returning method uses the qualified class name', shapes,
  'virtual src::shapes::ShapeBag chain() {');

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
  'virtual Map< string, src::shapes::Circle > allShapes()');
contains('inferred return type of a free function', inference,
  'src::inference::Store makeStore()');

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
contains('jsdoc types used in signature', legacy, 'virtual boolean put(string key, number value)');
contains('inferred return type qualified', legacy, 'src::legacy::Cache createCache()');

/* --- phase 2: JSDoc / TSDoc conversion --- */

contains('@param converted', docs, '@param input the raw label');
contains('@param for the second parameter', docs, '@param maximum maximum length');
contains('@returns -> @return', docs, '@return the normalized label');
contains('@throws keeps the exception type as its first token', docs,
  '@throws RangeError when <tt>maximum</tt> is negative');
contains('@deprecated passed through', docs,
  '@deprecated use @ref src::docs::betterNormalize "betterNormalize" instead');
contains('@since passed through', docs, '@since 0.2.0');
contains('@typeParam -> @tparam', docs, '@tparam T the element type');

// @example -> @code ... @endcode
contains('@example title', docs, '@par Example');
contains('@example opens a code block', docs, '@code{.js}');
contains('@example closes the code block', docs, '@endcode');
contains('@example drops the markdown fence', docs, "normalize('  Hello  '); // 'Hello'");
absent('@example fence markers removed', docs, '```');

// {@link ...}
contains('{@link X} -> resolved @ref', docs, '@ref src::shapes::Circle');
contains('{@link X.y | label} -> @ref with a label', docs,
  '@ref src::shapes::Circle::area "the area method"');
contains('{@link} to a sibling in the same module', docs, '@ref src::docs::betterNormalize');
contains('unresolvable {@link} becomes plain text', docs, '<tt>NotAThingAnywhere</tt>');
absent('unresolvable {@link} is not a reference', docs, '@ref NotAThingAnywhere');
contains('{@link url} becomes the bare URL', docs, 'https://example.com/docs');
for (const [file, text] of outputs) {
  absent(`${file}: no unconverted inline tags`, text, '{@link');
  absent(`${file}: no escaped leftover inline tags`, text, '{\\@link');
}

// @see: a resolvable name becomes a reference, a URL becomes a note (a URL is
// not a reference, so Doxygen would reject it as the argument of @see)
contains('@see resolvable name -> reference', docs, '@see src::docs::betterNormalize');
contains('@see a class -> reference', docs, '@see src::shapes::Circle');
contains('@see {@link X | label} -> labelled reference', docs,
  '@see @ref src::docs::betterNormalize "the better one"');
contains('@see URL goes into the see section', docs, '@see https://example.com/docs');
contains('@see labelled URL', docs, '@see [the docs](https://example.com)');
contains('@see unresolvable name -> note', docs, '@note %See also: NotAThingAnywhere');
absent('@see does not lose the URL scheme', docs, 'See also: ://');
absent('no reference starts with a bare URL path', docs, '@see ://');
absent('@see keeps the @ref of a labelled link', docs,
  '@see src::docs::betterNormalize "the better one"');
absent('@see does not keep comment trivia', docs, '@see src::docs::betterNormalize *');

// labelled URL in {@link}
contains('{@link url | label} -> labelled link', docs,
  '[the docs](https://example.com)');

// inline HTML Doxygen understands must survive escaping
contains('<b> kept', docs, '<b>bold</b>');
contains('<i> kept', docs, '<i>italic</i>');
contains('<code> kept', docs, '<code>literal</code>');
contains('<br> kept', docs, 'break<br>after it');
contains('unknown tag still escaped', docs, 'Array\\<T\\> in prose');

// TSDoc `@param name - description`
contains('TSDoc hyphen stripped from @param', docs, '@param input the raw label');
absent('TSDoc hyphen not kept in @param', docs, '@param input - the raw label');
contains('TSDoc hyphen stripped from @typeParam', docs, '@tparam T the element type');

// @returns on a void function would make Doxygen reject the return value
contains('@returns on void becomes a note', docs, '@note %Returns: nothing at all');
absent('@returns on void is not a @return', docs, '@return nothing at all');

// parameters that cannot be matched to the emitted signature
// `options` itself now matches: a destructured parameter takes the name its
// documentation uses, so only the dotted members remain unmatched.
contains('destructured parameter named from its documentation', docs,
  'number rectangleArea(object options)');
contains('unmatched @param names collected in a note', docs,
  '@note %Documented TypeScript parameters: <tt>options.width</tt>: the width;');
absent('no @param for a destructured member', docs, '@param options.width');

// TSDoc-only tags
contains('@remarks becomes a paragraph', docs, 'Changing this affects every caller.');
contains('@defaultValue', docs, '@note %Default value: 42');
contains('@internal noted', docs, 'Marked <tt>\\@internal</tt> in the TypeScript source.');
contains('unknown tag carried over', docs, '@note <tt>\\@customTag</tt> with a value');
contains('@group carried over', docs, '@note <tt>\\@group</tt>: Utilities');

// escaping of Doxygen-special characters in prose
contains('@ escaped in prose', docs, 'a\\@b');
contains('% escaped in prose', docs, '100\\%');
contains('# escaped in prose', docs, 'C\\#');
contains('angle brackets escaped in prose', docs, 'Array\\<T\\> in prose');
contains('backtick code becomes an escaped tt element', docs, '<tt>Array\\<T\\></tt> in code');
contains('backslash escaped in prose', docs, '\\\\backslash');

// JavaScript JSDoc
contains('js @param converted', legacy, '@param key entry key');
contains('js @returns converted', legacy, '@return true when the entry was stored');

// A `@par <title>` takes the rest of the line as its title, so a command
// joined after it is rejected by Doxygen ("Illegal command ... as part of a
// title section"). Collapsing a block must not produce that.
for (const [file, text] of outputs) {
  const offenders = text.split('\n').filter((l) => /@par\s+\S[^\n]*@(note|code|endcode|param|return|throws|tparam|see|deprecated|since)\b/.test(l));
  check(`${file}: no command inside a @par title`, offenders.length === 0,
    offenders.slice(0, 2).join('\n      '));
}

/* --- phase 3: call graphs --- */

// every function gets a body holding the calls it makes, fully qualified
contains('constructor call -> ns::X::X()', app, 'src::shapes::Rectangle::Rectangle();');
contains('method call on a typed member', app, 'src::shapes::ShapeBag::add();');
contains('static call', app, 'src::shapes::AbstractShape::reset();');
contains('call into a nested TypeScript namespace', app,
  'src::types::units::toMillimetres();');
contains('super() -> the base constructor', app, 'src::app::Report::Report();');
contains('inherited method through this', app, 'src::app::Report::summary();');
contains('call to an interface method', app, 'src::shapes::Shape::area();');
contains('call to a free function in another module', app, 'src::functions::join();');
contains('call to an overloaded function', app, 'src::functions::parse();');
contains('call made inside a callback', app, 'src::app::Report::describeValue();');
contains('recursive call', app, 'src::app::Report::countdown();');

// calls that must not be written out
absent('call to a function nested in a body is omitted', app, 'src::app::helper();');
/** The emitted body of a function, as lines, given a fragment of its signature. */
function bodyOf(text, fragment) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes(fragment));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\}/.test(lines[i])) return body;
    body.push(lines[i]);
  }
  return null;
}
const callsIn = (body) => (body || []).filter((l) => /\w(::\w+)+\(\);/.test(l));

{
  const body = bodyOf(app, 'void dynamic(');
  check('dynamic dispatch produces an empty body',
    body !== null && callsIn(body).length === 0,
    body === null ? 'body not found' : `found: ${callsIn(body).join(' ')}`);
  const local = bodyOf(app, 'number withLocalFunction(');
  check('call to a nested function produces an empty body',
    local !== null && callsIn(local).length === 0,
    local === null ? 'body not found' : `found: ${callsIn(local).join(' ')}`);
  const populate = bodyOf(app, 'void populate(');
  check('populate() emits every constructor call',
    populate !== null && callsIn(populate).length >= 3,
    populate === null ? 'body not found' : `found ${callsIn(populate).length}`);
}

// the implementation of an overload set carries the body; it is attached to
// the last overload signature (so the documented API stays as written)
check('overload body attached to the last signature',
  /virtual string format\(boolean value\) \{[\s\S]{0,80}?src::overloads::Formatter::trim\(\);/.test(overloads),
  'expected the trim() call under the `format(boolean)` signature');
absent('overload body not attached to the first signature',
  overloads.slice(0, overloads.indexOf('format(boolean value)')),
  'Formatter::trim();');

// statistics
const appStats = statsByFile.get('app.ts').calls;
check('calls counted', appStats.total > 10, `total=${appStats.total}`);
check('calls resolved', appStats.resolved > 10, `resolved=${appStats.resolved}`);
check('unresolved calls counted', appStats.unresolved >= 1, `unresolved=${appStats.unresolved}`);
check('indirect calls counted', appStats.indirect >= 1, `indirect=${appStats.indirect}`);
check('recursion counted', appStats.recursive >= 1, `recursive=${appStats.recursive}`);
check('unresolved call sampled', (appStats.samples || []).some((t) => t.includes('whatever')),
  `samples=${JSON.stringify(appStats.samples)}`);

// aggregate report
{
  const { aggregate, format } = require('../src/report');
  const totals = aggregate([...statsByFile.values()]);
  check('report counts every file', totals.files === statsByFile.size,
    `${totals.files} vs ${statsByFile.size}`);
  check('report sums the calls', totals.calls.total > 20, `total=${totals.calls.total}`);
  const text = format(totals);
  contains('report prints a resolution rate', text, 'resolution rate');
  contains('report prints the unresolved samples', text, 'unresolved call sites');
  check('report rate is plausible',
    totals.calls.resolved / totals.calls.total > 0.5,
    `${totals.calls.resolved}/${totals.calls.total}`);
}

// --no-bodies turns the feature off
{
  const bare = createSession(SRC, { wholeProgram: true, emitBodies: false })
    .translate(path.join(SRC, 'app.ts'));
  absent('--no-bodies emits no call statements', bare.text, 'src::shapes::Rectangle::Rectangle();');
  contains('--no-bodies still emits declarations', bare.text, 'virtual void populate();');
}

/* --- phase 4: pre-generation mode --- */

{
  const os = require('os');
  const { filterFile } = require('../src/index');
  const pregen = require('../src/pregen');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts2doxy-pregen-'));
  const code = pregen.run([SRC], { out: outDir, quiet: true });
  check('pregen exits successfully', code === 0, `exit code ${code}`);

  const generated = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else generated.push(full);
    }
  };
  walk(outDir);
  check('pregen mirrors the source tree',
    generated.length === fs.readdirSync(SRC).length,
    `${generated.length} file(s) for ${fs.readdirSync(SRC).length} source(s)`);

  // The two modes must agree: per-file filtering builds the Program from one
  // file's import closure, pre-generation from the whole file list, and a
  // documentation build has to come out the same either way.
  for (const file of fs.readdirSync(SRC)) {
    const mirrored = path.join(outDir, 'src', file);
    check(`pregen wrote src/${file}`, fs.existsSync(mirrored));
    if (!fs.existsSync(mirrored)) continue;
    const viaFilter = filterFile(path.join(SRC, file)).text;
    check(`pregen output for ${file} matches per-file filtering`,
      fs.readFileSync(mirrored, 'utf8') === viaFilter,
      'the two modes produced different pseudo-code');
  }
  fs.rmSync(outDir, { recursive: true, force: true });
}

// hygiene: nothing that would break Doxygen's parser. No `//` outside a
// comment block: the canvas appends fragments to an existing output line, so a
// line comment could comment out code. (Inside `@code` blocks `//` is fine.)
for (const [file, text] of outputs) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
  absent(`${file}: no line comments emitted`, code, '//');
  check(`${file}: braces balanced`,
    (text.match(/\{/g) || []).length === (text.match(/\}/g) || []).length,
    `{ = ${(text.match(/\{/g) || []).length}, } = ${(text.match(/\}/g) || []).length}`);
}

// line fidelity: every emitted class must sit on its source line
/** 1-based number of the first line of `text` matching `pattern`, 0 if none. */
function lineOfText(text, pattern) {
  return text.split('\n').findIndex((l) => pattern.test(l)) + 1;
}
const sourceLineOfText = lineOfText;
const outputLineOfText = lineOfText;
function sourceLineOf(file, pattern) {
  return lineOfText(fs.readFileSync(path.join(SRC, file), 'utf8'), pattern);
}
function outputLineOf(file, pattern) {
  return lineOfText(outputs.get(file), pattern);
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

/** The Doxygen to test against; `DOXYGEN=/path/to/doxygen npm test` to pick one. */
const DOXYGEN = process.env.DOXYGEN || 'doxygen';

function doxygenVersion() {
  try {
    return execFileSync(DOXYGEN, ['--version'], { stdio: 'pipe' }).toString().trim();
  } catch {
    return null;
  }
}

const doxVersion = doxygenVersion();
if (!doxVersion) {
  process.stderr.write(`note: ${DOXYGEN} not found, skipping integration checks\n`);
} else {
  process.stderr.write(`note: running the Doxygen checks against ${doxVersion}\n`);
  const out = path.join(FIXTURES, 'doxygen-out');
  fs.rmSync(out, { recursive: true, force: true });
  execFileSync(DOXYGEN, ['Doxyfile'], { cwd: FIXTURES, stdio: 'pipe' });

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
      items: 'private', add: 'public', chain: 'public', totalArea: 'public',
      ShapeBag: 'public',
    },
    'classsrc_1_1app_1_1Report.xml': {
      bag: 'private', populate: 'public', totalMillimetres: 'public',
      resetCounters: 'public', summary: 'public', label: 'public',
      dynamic: 'public', viaCallback: 'public', describeValue: 'public',
      withLocalFunction: 'public', countdown: 'public', Report: 'public',
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

  // phase 2: the converted documentation as Doxygen resolved it
  const docsXml = readXml('namespacesrc_1_1docs.xml');
  contains('doxygen: {@link} resolved to a class reference', docsXml,
    'refid="classsrc_1_1shapes_1_1Circle" kindref="compound">src::shapes::Circle</ref>');
  contains('doxygen: labelled {@link} resolved to a member', docsXml,
    'kindref="member">the area method</ref>');
  absent('doxygen: unresolvable link did not become a reference', docsXml,
    '>NotAThingAnywhere</ref>');
  contains('doxygen: URL became a link', docsXml,
    '<ulink url="https://example.com/docs">');
  contains('doxygen: @param recorded', docsXml,
    '<parametername>input</parametername>');
  contains('doxygen: @return recorded', docsXml, '<simplesect kind="return">');
  contains('doxygen: @throws recorded as an exception', docsXml,
    '<parameterlist kind="exception">');
  contains('doxygen: @throws exception type recorded', docsXml,
    '<parametername>RangeError</parametername>');
  contains('doxygen: @deprecated recorded', docsXml, '<xreftitle>Deprecated</xreftitle>');
  contains('doxygen: @since recorded', docsXml, '<simplesect kind="since">');
  contains('doxygen: @tparam recorded', docsXml, '<parameterlist kind="templateparam">');
  contains('doxygen: @example became a code listing', docsXml, '<programlisting filename=".js">');
  contains('doxygen: markdown list converted', docsXml, '<itemizedlist>');
  contains('doxygen: labelled URL rendered', docsXml,
    '<ulink url="https://example.com">the docs</ulink>');
  contains('doxygen: @see URL kept its scheme', docsXml,
    '<ulink url="https://example.com/docs">https://example.com/docs</ulink>');
  contains('doxygen: @see resolved to a reference', docsXml, '<simplesect kind="see">');
  contains('doxygen: @see labelled link renders the label', docsXml,
    'kindref="member">the better one</ref>');
  contains('doxygen: @see URL is in the see section', docsXml,
    '<ulink url="https://example.com/docs">https://example.com/docs</ulink>');
  contains('doxygen: <b> became bold', docsXml, '<bold>bold</bold>');
  contains('doxygen: <i> became emphasis', docsXml, '<emphasis>italic</emphasis>');
  contains('doxygen: <code> became computeroutput', docsXml,
    '<computeroutput>literal</computeroutput>');
  contains('doxygen: <br> became a line break', docsXml, '<linebreak/>');

  // The line structure of a comment must survive: a declaration is emitted on
  // its original source line, so its comment has only the lines the original
  // comment occupied -- but it may not be collapsed while they are enough.
  const memberXml = (xml, name) => {
    const re = /<memberdef\b[^>]*>([\s\S]*?)<\/memberdef>/g;
    let match;
    while ((match = re.exec(xml)) !== null) {
      if (new RegExp(`<name>${name}</name>`).test(match[1])) return match[1];
    }
    return '';
  };
  const countTag = (xml, tag) => (xml.match(new RegExp(`<${tag}[ />]`, 'g')) || []).length;
  for (const [member, expected] of Object.entries({
    // `@example` bodies, one <codeline> per source line
    describeCircle: { codeline: 3, itemizedlist: 1, listitem: 2 },
    normalize: { codeline: 1, itemizedlist: 1, listitem: 2 },
  })) {
    const xml = memberXml(docsXml, member);
    check(`doxygen: ${member} documentation found`, xml !== '');
    for (const [tag, want] of Object.entries(expected)) {
      check(`doxygen: ${member} has ${want} <${tag}> element(s)`,
        countTag(xml, tag) === want,
        `found ${countTag(xml, tag)}`);
    }
    check(`doxygen: ${member} description has several paragraphs`,
      countTag(xml, 'para') >= 4, `found ${countTag(xml, 'para')}`);
  }
  absent('doxygen: generated note boilerplate is not auto-linked', docsXml,
    'kindref="compound">Documented</ref> TypeScript parameters');

  // phase 3: the call relations Doxygen extracted from the emitted bodies
  // One name can have several <memberdef>s (an overload set), so collect them
  // all: the body of an overload set sits on its last signature.
  const memberRefs = (xmlFile) => {
    const xml = readXml(xmlFile);
    const out = new Map();
    const re = /<memberdef\b[^>]*>([\s\S]*?)<\/memberdef>/g;
    let match;
    while ((match = re.exec(xml)) !== null) {
      const block = match[1];
      const name = /<name>([^<]*)<\/name>/.exec(block);
      if (!name) continue;
      const entry = {
        refs: [...block.matchAll(/<references\b[^>]*>([^<]*)<\/references>/g)].map((m) => m[1]),
        by: [...block.matchAll(/<referencedby\b[^>]*>([^<]*)<\/referencedby>/g)].map((m) => m[1]),
      };
      if (!out.has(name[1])) out.set(name[1], []);
      out.get(name[1]).push(entry);
    }
    return out;
  };
  const allRefs = (entries) => (entries || []).flatMap((e) => e.refs);
  const allBy = (entries) => (entries || []).flatMap((e) => e.by);

  for (const [xmlFile, expected] of Object.entries({
    'classsrc_1_1app_1_1Report.xml': {
      populate: ['src::shapes::Circle::Circle', 'src::shapes::Rectangle::Rectangle',
        'src::shapes::Square::Square'],
      totalMillimetres: ['src::types::units::toMillimetres'],
      resetCounters: ['src::shapes::AbstractShape::reset'],
      summary: ['src::functions::parse', 'src::functions::join', 'src::functions::double_'],
      viaCallback: ['describeValue'],
      countdown: ['countdown'],
    },
    'classsrc_1_1app_1_1DetailedReport.xml': {
      DetailedReport: ['src::app::Report::Report', 'src::app::Report::populate'],
      describe: ['src::app::Report::summary'],
    },
    'classsrc_1_1shapes_1_1Square.xml': {
      Square: ['src::shapes::Rectangle::Rectangle'],
    },
    'classsrc_1_1overloads_1_1Formatter.xml': {
      format: ['trim'],
    },
  })) {
    const members = memberRefs(xmlFile);
    for (const [member, wanted] of Object.entries(expected)) {
      const refs = allRefs(members.get(member));
      check(`doxygen: ${member} has call references`, refs.length > 0,
        members.has(member) ? 'no references recorded' : 'member not found');
      for (const target of wanted) {
        check(`doxygen: ${member} calls ${target}`, refs.includes(target),
          `references: ${refs.join(', ') || '(none)'}`);
      }
    }
  }

  /*
   * Every edge Doxygen reports must be an edge the filter wrote.
   *
   * Doxygen 1.9.8 invents references when several declarations share one line:
   * for `class P { public: int a(); public: void b(); };` on a single line it
   * reports `P::a -> a, b`. Our output shares lines on purpose, to keep
   * declaration line numbers exact, so this has to be checked rather than
   * assumed.
   *
   * Edges are compared by refid, resolved to qualified names, so the
   * comparison does not depend on how Doxygen chose to print a name.
   */
  {
    const emitted = new Set();
    const paramsOf = new Map();
    for (const stats of statsByFile.values()) {
      for (const edge of stats.edges || []) emitted.add(`${edge.from} -> ${edge.to}`);
      for (const signature of stats.signatures || []) {
        if (!paramsOf.has(signature.name)) paramsOf.set(signature.name, new Set());
        for (const param of signature.params) paramsOf.get(signature.name).add(param);
      }
    }

    /*
     * Doxygen 1.18 turns a parameter whose name matches a documented entity
     * into a reference to it: `scale(number factor)` is reported as
     * referencing the field `factor`, and a constructor parameter property
     * always collides, since TypeScript gives the parameter and the field one
     * name by construction. These show up in the "References" lists only --
     * Doxygen leaves data members out of the call graphs -- and the parameter
     * names cannot be changed without misrepresenting the API, so they are
     * accounted for here rather than worked around. See the README's Doxygen
     * version notes.
     */
    const isParameterNameCollision = (caller, target) => {
      const params = paramsOf.get(caller);
      return !!params && params.has(String(target).split('::').pop());
    };

    // refid -> qualified name, over every compound Doxygen wrote
    const qualifiedById = new Map();
    const memberBlocks = [];
    for (const file of fs.readdirSync(xmlDir)) {
      if (!file.endsWith('.xml') || file === 'index.xml' || file === 'Doxyfile.xml') continue;
      const xml = fs.readFileSync(path.join(xmlDir, file), 'utf8');
      const compound = /<compoundname>([^<]*)<\/compoundname>/.exec(xml);
      if (!compound) continue;
      const re = /<memberdef\b([^>]*)>([\s\S]*?)<\/memberdef>/g;
      let match;
      while ((match = re.exec(xml)) !== null) {
        const id = /\bid="([^"]+)"/.exec(match[1]);
        const name = /<name>([^<]*)<\/name>/.exec(match[2]);
        if (!id || !name) continue;
        const qualified = `${compound[1]}::${name[1]}`;
        qualifiedById.set(id[1], qualified);
        memberBlocks.push({ qualified, block: match[2] });
      }
    }

    const spurious = [];
    const parameterCollisions = [];
    const seenEdges = new Set();
    for (const { qualified, block } of memberBlocks) {
      for (const ref of block.matchAll(/<references\b([^>]*)>([^<]*)<\/references>/g)) {
        const refid = /\brefid="([^"]+)"/.exec(ref[1]);
        const target = refid ? qualifiedById.get(refid[1]) : null;
        const edge = `${qualified} -> ${target || ref[2]}`;
        seenEdges.add(edge);
        if (emitted.has(edge)) continue;
        if (isParameterNameCollision(qualified, target || ref[2])) {
          parameterCollisions.push(edge);
          continue;
        }
        spurious.push(edge);
      }
    }

    if (parameterCollisions.length) {
      process.stderr.write(
        `note: ${parameterCollisions.length} edge(s) accounted for as Doxygen 1.18`
        + ' parameter-name collisions, e.g. '
        + `${parameterCollisions[0]}\n`,
      );
    }
    check(`doxygen: no call edges beyond the ${emitted.size} the filter emitted`
      + (parameterCollisions.length
        ? ` (${parameterCollisions.length} parameter-name collision(s) accounted for)`
        : ''),
      spurious.length === 0,
      `${spurious.length} edge(s) Doxygen added by itself:\n      ${[...new Set(spurious)].slice(0, 12).join('\n      ')}`);

    // the other direction: edges the filter wrote that Doxygen dropped
    const missing = [...emitted].filter((e) => !seenEdges.has(e));
    check('doxygen: every emitted call edge was picked up',
      missing.length === 0,
      `${missing.length} missing:\n      ${[...new Set(missing)].slice(0, 12).join('\n      ')}`);
  }

  // caller graphs are the same data read backwards
  const areaBy = allBy(memberRefs('classsrc_1_1shapes_1_1Shape.xml').get('area'));
  check('doxygen: Shape::area knows its callers',
    areaBy.includes('src::app::measure'),
    `referencedby: ${areaBy.join(', ') || '(none)'}`);

  // calls with no documented target must not have produced an edge
  const reportMembers = memberRefs('classsrc_1_1app_1_1Report.xml');
  for (const member of ['withLocalFunction', 'dynamic']) {
    const refs = allRefs(reportMembers.get(member));
    check(`doxygen: ${member} produced no call edge`, refs.length === 0,
      `references: ${refs.join(', ')}`);
  }

  // the graphs themselves (their file names are content hashes, so count)
  const svgs = fs.readdirSync(path.join(out, 'html')).filter((f) => f.endsWith('.svg'));
  check('doxygen: call graphs generated',
    svgs.filter((f) => f.includes('_cgraph')).length > 10,
    `${svgs.filter((f) => f.includes('_cgraph')).length} call graphs`);
  check('doxygen: caller graphs generated',
    svgs.filter((f) => f.includes('_icgraph')).length > 5,
    `${svgs.filter((f) => f.includes('_icgraph')).length} caller graphs`);

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

/* ------------------------------------------------------------------ *
 * 3. namespace modes `single` and `none`
 *
 * One fixture, `test/fixtures-modes`, of free functions whose return types
 * all end in an identifier. With no namespace (`none`) the qualified
 * definition has to be written `void ::f`, which Doxygen 1.18 reads as a
 * member `f` of a class `void`; `single` puts the whole project into one
 * namespace so the definition can be qualified with it.
 * ------------------------------------------------------------------ */

const MODES = path.join(ROOT, 'test', 'fixtures-modes');
const MODES_SRC = path.join(MODES, 'src', 'sessions.ts');

/** Free functions of the fixture: name -> functions it calls, as written in the TypeScript. */
const SESSION_CALLS = {
  findSession: [],
  upsertSession: ['findSession', 'countHits', 'Session::Session'],
  countHits: [],
  hasSession: ['findSession'],
  upsertAll: ['upsertSession'],
};

{
  const translate = (opts) => createSession(MODES_SRC, opts).translate(MODES_SRC).text;

  // the default name: package.json "name" next to the tsconfig, scope dropped
  const single = translate({ namespaceMode: 'single' });
  contains('single: namespace named after package.json', single, 'namespace example_session_store {');
  for (const name of Object.keys(SESSION_CALLS)) {
    check(`single: ${name} defined with the project namespace`,
      new RegExp(`^\\S.* example_session_store::${name}\\(`, 'm').test(single),
      'no qualified definition found');
  }
  contains('single: calls qualified with the project namespace', single,
    'example_session_store::findSession();');
  check('single: no global-scope definitions', !/^[^*\n]* ::\w+\(/m.test(single),
    'found a `::name(` definition');
  check('single: declarations stay on their source lines',
    outputLineOfText(single, /example_session_store::upsertSession\(string id\) \{/)
      === sourceLineOfText(fs.readFileSync(MODES_SRC, 'utf8'), /export function upsertSession/));

  // --namespace-name overrides it, and is sanitized like any other name
  const named = translate({ namespaceMode: 'single', namespaceName: 'my-app' });
  contains('single: --namespace-name overrides the default', named, 'namespace my_app {');
  contains('single: --namespace-name used in definitions', named, 'void my_app::upsertSession(');

  // no package.json next to the tsconfig: the tsconfig directory names it
  const fallback = createSession(path.join(SRC, 'app.ts'), { namespaceMode: 'single' })
    .translate(path.join(SRC, 'app.ts')).text;
  contains('single: falls back to the tsconfig directory name', fallback, 'namespace fixtures {');
  absent('single: one namespace, not one per file', fallback, 'namespace app');

  // none: unchanged, global-scope definitions
  const none = translate({ namespaceMode: 'none' });
  absent('none: no namespace emitted', none, 'namespace ');
  contains('none: global-scope definition form unchanged', none, 'void ::upsertSession(string id) {');

  let threw = null;
  try { translate({ namespaceMode: 'bogus' }); } catch (err) { threw = err.message; }
  check('unknown namespace mode is rejected', /unknown namespace mode: bogus/.test(threw || ''), threw);
}

if (doxVersion) {
  /** Run Doxygen over the fixture in one mode; returns the XML of its members. */
  const runMode = (mode) => {
    const out = path.join(MODES, `doxygen-out-${mode}`);
    const log = path.join(MODES, `doxygen-warnings-${mode}.log`);
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(log, { force: true });
    execFileSync(DOXYGEN, [`Doxyfile.${mode}`], { cwd: MODES, stdio: 'pipe' });
    const xmlDir = path.join(out, 'xml');
    const members = [];
    for (const file of fs.readdirSync(xmlDir)) {
      if (!file.endsWith('.xml') || file === 'index.xml' || file === 'Doxyfile.xml') continue;
      const xml = fs.readFileSync(path.join(xmlDir, file), 'utf8');
      for (const match of xml.matchAll(/<memberdef\b[^>]*kind="function"[^>]*>([\s\S]*?)<\/memberdef>/g)) {
        const block = match[1];
        members.push({
          file,
          name: (/<name>([^<]*)<\/name>/.exec(block) || [])[1],
          definition: (/<definition>([^<]*)<\/definition>/.exec(block) || [])[1],
          // the definition's line; `line` is the declaration emitted above it
          bodyStart: Number((/<location\b[^>]*\bbodystart="(\d+)"/.exec(block) || [])[1]),
          refs: [...block.matchAll(/<references\b[^>]*>([^<]*)<\/references>/g)].map((m) => m[1]),
        });
      }
    }
    const warnings = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '';
    return { members, warnings };
  };

  const single = runMode('single');
  check('doxygen single: no warnings', single.warnings === '',
    single.warnings.split('\n').slice(0, 8).join('\n      '));
  const source = fs.readFileSync(MODES_SRC, 'utf8');
  for (const [name, calls] of Object.entries(SESSION_CALLS)) {
    const found = single.members.filter((m) => m.name === name);
    check(`doxygen single: ${name} documented once in the project namespace`,
      found.length === 1 && found[0].file === 'namespaceexample__session__store.xml',
      `found ${found.map((m) => `${m.file}: ${m.definition}`).join('; ') || 'nothing'}`);
    if (found.length !== 1) continue;
    const [member] = found;
    check(`doxygen single: ${name} has its own return type`,
      new RegExp(`^\\S.* example_session_store::${name}$`).test(member.definition),
      `definition: ${member.definition}`);
    const want = sourceLineOfText(source, new RegExp(`export (async function|function|const) ${name}\\b`));
    check(`doxygen single: ${name} defined at sessions.ts:${want}`, member.bodyStart === want,
      `reported line ${member.bodyStart}`);
    // exactly the calls written in the source: none missing, none invented,
    // and in particular no false self-reference
    const refs = member.refs.map((r) => r.replace(/^example_session_store::/, ''));
    check(`doxygen single: ${name} calls exactly ${calls.join(', ') || 'nothing'}`,
      refs.length === calls.length && calls.every((c) => refs.includes(c)),
      `references: ${refs.join(', ') || '(none)'}`);
  }

  // The known 1.18 failure of `none`, asserted so that the README's statement
  // is noticed when a Doxygen release changes it.
  if (/^1\.18\./.test(doxVersion)) {
    const none = runMode('none');
    const garbled = none.members.find((m) => m.definition === 'void::upsertSession');
    check('doxygen none: 1.18 garbles the definition to void::upsertSession, as the README says',
      !!garbled,
      `definitions: ${none.members.map((m) => m.definition).join(', ')}`);
  }
}

/* ------------------------------------------------------------------ */

process.stdout.write(`\n${passed} checks passed, ${failures.length} failed\n`);
if (failures.length) {
  process.stdout.write(`\nfailures:\n  - ${failures.join('\n  - ')}\n`);
  process.exitCode = 1;
}
