# ts2doxy

A [Doxygen](https://www.doxygen.nl/) input filter that makes Doxygen document
TypeScript and JavaScript projects — including the three things TypeDoc does
not give you:

* **UML class diagrams** (`UML_LOOK`, with fields and operations in the boxes)
* **inheritance and collaboration diagrams**
* **call graphs and caller graphs**

Doxygen itself is not patched. `ts2doxy` translates each TS/JS file into
C++-like pseudo-code on stdout, and Doxygen's own C++ parser takes it from
there — the same trick [doxypypy](https://github.com/Feneric/doxypypy) uses for
Python.

Declarations are emitted **on their original source line**, so with
`FILTER_SOURCE_FILES = NO` Doxygen shows your real TypeScript in the source
browser and every “Definition at line N” is correct.

## Requirements

* Node.js ≥ 18
* Doxygen ≥ 1.9 — tested against **1.9.8** and **1.18.0**
  (see [Doxygen versions](#doxygen-versions))
* Graphviz (`dot`) for the diagrams (developed against 2.43)

The only runtime dependency is the `typescript` package (Apache-2.0); `ts2doxy`
uses its Compiler API **including the type checker**, which is what makes
cross-file inheritance and call resolution possible.

## Installation

`ts2doxy` is not published on npm, and it cannot be installed as a git
dependency either:

```sh
npm install --save-dev ts2doxy
# npm error 404 Not Found - GET https://registry.npmjs.org/ts2doxy

npm install --save-dev git+https://github.com/kimpertinent/ts2doxy.git
# npm error code EALLOWGIT
# npm error Fetching packages of type "git" have been disabled
```

Install it by cloning it. The clone does not have to live inside the project
you document:

```sh
git clone https://github.com/kimpertinent/ts2doxy
cd ts2doxy
npm ci            # installs the one dependency, `typescript`, from the lockfile
node bin/ts2doxy.js --help
```

Nothing is compiled; `bin/ts2doxy.js` runs straight from the clone. `npm ci` is
not optional — without it every invocation fails with
`Cannot find module 'typescript'`.

Then, in the project you want to document, point Doxygen at the clone with an
**absolute** path, and quote the command:

```
FILTER_PATTERNS = *.ts="sh /abs/path/to/ts2doxy/bin/ts2doxy-filter.sh" \
                  *.tsx="sh /abs/path/to/ts2doxy/bin/ts2doxy-filter.sh" \
                  ...
```

`bin/ts2doxy-filter.sh` is a POSIX shell wrapper around `bin/ts2doxy.js` that
serves [filter-cache](#the-filter-cache-on-by-default) hits without starting
node; everything else it hands to node unchanged. Calling node directly works
too and gives the same output, only slower per file:

```
FILTER_PATTERNS = *.ts="node /abs/path/to/ts2doxy/bin/ts2doxy.js" \
                  *.tsx="node /abs/path/to/ts2doxy/bin/ts2doxy.js" \
                  ...
```

Both parts matter. Doxygen runs the filter through `/bin/sh`, from the
directory you start `doxygen` in — not from your interactive shell — so a bare
`ts2doxy.js` or a relative path that works when you type it may not be found
there; `node` itself must be on the `PATH` that `/bin/sh` sees, for the
wrapper as well. And an unquoted command is split at the first space, which
makes Doxygen run plain `sh` or `node` on your TypeScript. See
[Troubleshooting](#troubleshooting).

Run `npm install` once in the project you document as well: `ts2doxy` builds a
real TypeScript program, so it needs that project's own dependencies and
`@types/*` packages to resolve imports.

## Usage

### As a Doxygen filter

Copy `Doxyfile.sample` into your project, point `INPUT` at your sources, put
the path of your clone into `FILTER_PATTERNS` and run `doxygen`. The three
settings that do the work:

```
EXTENSION_MAPPING   = ts=C++ tsx=C++ mts=C++ cts=C++ js=C++ jsx=C++ mjs=C++ cjs=C++
FILE_PATTERNS       = *.ts *.tsx *.mts *.cts *.js *.jsx *.mjs *.cjs
FILTER_PATTERNS     = *.ts="sh /abs/path/to/ts2doxy/bin/ts2doxy-filter.sh" ...
FILTER_SOURCE_FILES = NO
```

`Doxyfile.sample` is commented; the settings worth knowing about are:

| Setting | Why |
| --- | --- |
| `EXTENSION_MAPPING = ts=C++` | Doxygen has no TypeScript parser. Its built-in `Javascript` parser does not produce class, inheritance or call graphs, which is the whole point of this filter. |
| `FILTER_SOURCE_FILES = NO` | Keeps the source browser showing the original TypeScript. The filter preserves line numbers, so references still land correctly. |
| `SOURCE_BROWSER = YES` | **Required for the call and caller graphs.** Doxygen only records cross-references while it runs the source browser pass. With `SOURCE_BROWSER = NO` every edge the filter emits is lost and Doxygen puts bogus self-references in their place (measured on the test fixtures: 35 real edges gone, 25 invented). |
| `EXTRACT_ALL = YES` | Undocumented declarations are translated too; this makes them appear, and keeps call graphs complete. |
| `ENABLE_PREPROCESSING = NO` | The pseudo-code contains no preprocessor directives. (Doxygen 1.9.8 ignores `#line` directives, which is why line numbers are preserved by layout instead.) |
| `BUILTIN_STL_SUPPORT = YES` | TypeScript function types are emitted as `std::function<...>`; this stops Doxygen documenting those as user classes. |
| `INCLUDE_GRAPH`/`INCLUDED_BY_GRAPH = NO` | No `#include` directives are emitted, so those graphs would always be empty. |
| `UML_LIMIT_NUM_FIELDS = 0`, `DOT_UML_DETAILS = YES` | Show all members with their types inside the UML boxes. |
| `GENERATE_XML = YES` | Machine-readable output, for post-processing the extracted model (member lists, protection, locations, call references) with your own tools. |

### On the command line

```sh
node /abs/path/to/ts2doxy/bin/ts2doxy.js src/thing.ts   # translate one file
```

The rest of this README writes `ts2doxy` as shorthand for
`node /abs/path/to/ts2doxy/bin/ts2doxy.js`:

```sh
ts2doxy --stats stats.jsonl src/thing.ts
ts2doxy report stats.jsonl           # aggregate the collected statistics
ts2doxy --help
```

Options:

| Option | Meaning |
| --- | --- |
| `-p, --project <tsconfig>` | tsconfig to use. Default: nearest `tsconfig.json`/`jsconfig.json` walking up from the input file. |
| `-r, --root <dir>` | Directory namespaces are derived from. Default: `rootDir` from the tsconfig, else the tsconfig's directory, else the nearest `package.json` directory. |
| `-n, --namespace-mode <m>` | `path` (default), `flat` (one namespace per file), `single` (one namespace for the whole project) or `none` (global scope; broken on Doxygen 1.18, see [Doxygen versions](#doxygen-versions) — use `single` instead). |
| `--namespace-name <name>` | Namespace for `--namespace-mode single`. Default: the `name` field of the `package.json` next to the tsconfig (a scoped `@scope/pkg` becomes `scope_pkg`), else the tsconfig's directory name. Sanitized to a C++ identifier either way. |
| `--whole-program` | Build the `Program` from the full tsconfig file list instead of just the input file's import closure. Slower; needed only when symbols are shared through globals rather than imports. |
| `--no-bodies` | Emit declarations only, without the call-graph bodies. |
| `--list-unresolved` | Mark unresolved call sites in the output with a comment. |
| `--no-implicit-ctors` | Do not synthesize constructors for classes that declare none. |
| `--no-virtual` | Do not mark instance methods `virtual`. |
| `--no-cache` | Translate the file directly, without the [filter cache](#the-filter-cache-on-by-default) — what every filter run did before the cache. Nothing is read from or written to the cache. |
| `--cache-dir <dir>` | Where the filter cache lives. Default: `$XDG_CACHE_HOME/ts2doxy`, else `~/.cache/ts2doxy`. |
| `--strict` | Exit non-zero on errors. By default a file that fails to translate is skipped with a warning on stderr, so one bad file cannot abort a documentation build. |

## Mapping rules

| TypeScript | Emitted pseudo-code |
| --- | --- |
| file `src/util/text.ts` | `namespace src { namespace util { namespace text { … } } }` (a trailing `index` segment is dropped) |
| `class` | `class` |
| `extends`, `implements` | `public` inheritance, with the base name fully qualified |
| `interface` | `class` with pure virtual methods and public data members |
| `abstract` method | `virtual … = 0` |
| `static` | `static` |
| `readonly` | `const` |
| `public`/`protected`/`private`/`#private` | `public:` / `protected:` / `private:` sections |
| generics | `template< typename T, … >`; constraints and defaults go into the doc block |
| function, and arrow function assigned to a `const` | free function |
| overloads | one declaration per overload signature. The implementation signature is not documented: it is not callable, and its parameter types are the union of all overloads. |
| `enum`, `const enum` | `enum class` |
| `type` alias | `typedef` (or `template<…> using` when generic); original TS text kept in the doc block |
| union / intersection | sanitized identifier (`string_or_number`, `A_and_B`); `T \| null` and `T \| undefined` collapse to `T` so that the member still links to `T` |
| literal and template-literal types | the underlying primitive (`string`, `number`, `boolean`) |
| mapped / conditional / `keyof` / indexed-access types | `MappedType`, `ConditionalType`, `keyof_X`, `X_element` |
| tuple, array, function type | `Tuple< A, B >`, `Array< E >`, `std::function< R(A) >` |
| index signature | `V operator[](K key)` |
| call / construct signature | `R operator()(…)` / a constructor |
| getter / setter | a method pair (noted as such in the docs) |
| constructor parameter property | a constructor parameter **and** a data member |
| `namespace X {}` | nested `namespace X {}` |
| default / named exports | `@note` in the doc block |

Every class member is emitted with an explicit access specifier
(`public:`/`protected:`/`private:`) rather than relying on C++ access sections:
members with different access can share an output line (a constructor and the
parameter properties it declares), and a stale section would silently change
the protection Doxygen reports for everything after it.

Types that are not annotated are taken from the type checker structurally, so
type arguments and qualified names survive: `private index = new Map<string,
number>()` becomes `Map< string, number >`, and `new Map<string, Circle>()`
becomes `Map< string, other::module::Circle >`.

Names that collide with a C++ keyword get a trailing underscore
(`const double = …` becomes `number double_(…)`), because the output has to go
through a C++ parser.

Instance methods are marked `virtual` by default: every TypeScript method is
dynamically dispatched, and it makes Doxygen show “Implements” /
“Reimplemented from” links. Use `--no-virtual` to turn that off.

Classes that declare no constructor get a synthesized one, documented as such.
Without it Doxygen has no node to draw `new Foo()` call edges to. Use
`--no-implicit-ctors` to turn that off.

## Performance: the filter cache and pre-generation mode

Doxygen runs an input filter once per file, and in fact more than once (two
runs per file on the fixtures, 992 runs for 496 files on TypeORM). Each run
of the plain filter has to build a TypeScript program and a type checker
before it can resolve anything. On one fixture file that breaks down as 199 ms
to load the `typescript` module, 345 ms to build the program, 115 ms for the
checker and 89 ms of actual translation — the fixed cost is nine tenths of it.

### The filter cache (on by default)

So the filter does that work once. The first filter run of a Doxygen run
translates **every file of the tsconfig** in one pass — the same work
`ts2doxy pregen` does — and stores the results in a cache. Every later run
checks that nothing the cache was built from has changed and prints the stored
text, without loading `typescript` at all. Doxygen still reads your original
files, so the source browser shows the real TypeScript
(`FILTER_SOURCE_FILES = NO`), exactly as before. Nothing has to be configured.

Measured on [TypeORM](https://github.com/typeorm/typeorm) 1.1.2,
`packages/typeorm/src` (496 files documented; the tsconfig covers 3279 files
including the tests, so the cache translates all of those), Doxygen 1.18.0,
HTML and XML output, whole Doxygen run:

| filter | `HAVE_DOT = NO` | `HAVE_DOT = YES` |
| --- | --- | --- |
| node + cache, first run (cache built) | 92.1 s | 104.8 s |
| node + cache, unchanged sources | 81.7 s | 94.5 s |
| shell wrapper + cache, first run | 49.5 s | 63.8 s |
| shell wrapper + cache, unchanged sources | **39.0 s** | **49.7 s** |

For comparison, the plain filter took 1697 s on the same sources (measured
earlier with Doxygen 1.9.8, XML only, no Graphviz; not repeated), and
pre-generation ~10 s plus Graphviz. All runs produced identical XML.

Per filter run on a cache hit:

| | TypeORM (5586 paths checked) | test fixtures (89 paths) |
| --- | --- | --- |
| `node bin/ts2doxy.js` | 79 ms | 37 ms |
| `sh bin/ts2doxy-filter.sh` | 34 ms | 6.8 ms |
| plain filter, no cache | 1.7 s (1697 s for 992 runs, Doxygen 1.9.8) | 1.2 s |

Building the cache for TypeORM's 3279 files takes about 10 s, once.

What the cache guarantees:

* **The output is byte-identical to the plain filter**, for every file; the
  test suite checks that for every fixture, in the default and the `single`
  namespace mode.
* **It notices changes.** An entry records size and modification time of every
  file the TypeScript compiler read while building it — your sources, the
  imported `.d.ts` files, the tsconfig and every config it `extends`, the
  `package.json` next to the tsconfig, `ts2doxy`'s own sources and the
  `typescript` version — and the listing of every directory the tsconfig's
  `include` covers, recursively, so that added and deleted files are noticed
  too. Any
  difference rebuilds the entry, on the next filter run. A file is
  fingerprinted *before* it is read, so an edit made while the cache is being
  built is caught by the next run.
* **It is safe with parallel filter runs** (`NUM_PROC_THREADS`). One run builds
  while the others wait on a lock; the result becomes visible in one atomic
  rename, so no run ever sees a half-written cache. A lock left behind by a
  process that died is broken automatically.
* **It never costs a translation.** If anything about the cache fails, the
  file is translated directly, with a warning on stderr.

The cache lives in `--cache-dir <dir>` if given, else in
`$XDG_CACHE_HOME/ts2doxy`, i.e. `~/.cache/ts2doxy` by default, with one entry
per tsconfig and set of output-relevant options. Old entries are not pruned;
deleting the cache directory is always safe. `--no-cache` bypasses the cache
entirely and translates each file directly, as before the cache existed.

### The shell wrapper

`bin/ts2doxy-filter.sh` takes the same arguments as `bin/ts2doxy.js`. On a
cache hit it finds the cache entry, checks freshness with a single
`xargs -0 stat` call compared byte for byte against a snapshot the node side
wrote, and prints the stored translation — no node process at all. It is
written for POSIX `sh` (tested with dash, Debian's and Ubuntu's `/bin/sh`).

It only ever answers when it is certain; everything else is handed to
`node bin/ts2doxy.js` with the arguments unchanged, so its output is always
exactly what node would print. It falls back on:

* no cache entry yet, an entry being built (lock present), or a stale entry —
  any input file or watched directory whose size or modification time differs,
  or an input that was absent and now exists;
* `--no-cache`, `--stats` and any other option it does not handle itself
  (it handles `-p`, `-r`, `-n`, `--namespace-name`, `--cache-dir`,
  `--no-implicit-ctors`, `--no-virtual`, `--no-bodies`, `--list-unresolved`,
  `--strict`, `-q`), a missing or empty option value, a second file name;
* a file name that is not already normalized (`..`, `.`, `//`), values that
  would need escaping in the cache key (quotes, backslashes, control or
  non-ASCII characters), a file outside the tsconfig's file list;
* a `stat` that is not GNU's. The snapshot is written only after the node side
  has run that exact `stat` command once and reproduced it, so on macOS and
  the BSDs (whose `stat` has no `-c`), with busybox, or with an old coreutils,
  the entry has no snapshot and every run goes to node — correct, just without
  the speed-up;
* missing tools (`xargs`, `stat`, `cmp`, `cat`), no `$HOME`.

A directory that was merely touched (Doxygen creating its output next to your
sources) makes the wrapper fall back once; node confirms the listing is
unchanged and refreshes the snapshot, and the wrapper serves hits again.

The cost of a hit grows with the size of the tsconfig project, since every
file in it is checked. TypeORM's tsconfig includes its 2782 test files next to
the 496 sources, so each hit checks 5586 paths. A tsconfig that covers only
what you document (passed with `-p`) makes hits proportionally cheaper.

Files the cache does not cover are translated the plain way, slowly but
correctly:

* files that are not in the tsconfig's file list (excluded by `include` /
  `exclude`, or a project without any tsconfig.json/jsconfig.json);
* files that failed to translate in the whole-project pass, so that their
  error is reported exactly as before.

Building the cache translates the whole tsconfig project even if Doxygen's
`INPUT` covers only part of it; the first filter run of a documentation run
takes that long.

### Pre-generation mode

Faster still, because Doxygen then starts no filter process at all:

```sh
ts2doxy pregen src --out doxygen-pregen
```

Measured on [TypeORM](https://github.com/typeorm/typeorm) 1.1.2,
`packages/typeorm/src`, 496 source files, with Doxygen 1.9.8 (XML output,
`HAVE_DOT = NO` on both sides so the comparison is about reading the project):

| | translation | Doxygen | total |
| --- | --- | --- | --- |
| plain per-file filtering, before the cache | — | — | **1697 s** |
| pre-generation (`ts2doxy pregen`) | 6.1 s | 4 s | **~10 s** |

It builds one program for the whole tree (1.7 s of the 6.1 s above) and writes
a mirror of it, 9 ms per file. Then point Doxygen at that tree and drop the
filter — `INPUT = doxygen-pregen`, no `FILTER_PATTERNS`; `EXTENSION_MAPPING` is
still needed. `Doxyfile.sample` has the exact settings in a comment.

Pre-generation produces **byte-identical** output to the filter (the test suite
checks that for every fixture). The trade-off: Doxygen has no original file
to show, so the source browser lists the generated pseudo-code instead of
your TypeScript. Line numbers still match the sources. That is why the
filter, with its cache, remains the default in `Doxyfile.sample`.

Pre-generation exits non-zero if any file failed, and tells you where the
time went, how many declarations could not keep their source line, and the
call resolution rate.

## Call graphs

Doxygen builds call and caller graphs by parsing function *bodies*, so every
function is emitted with a body containing nothing but the calls it makes,
each written as a fully qualified call statement on the line the original call
occupies:

```cpp
virtual void populate() {
src::shapes::ShapeBag::add(); src::shapes::Rectangle::Rectangle();
src::shapes::ShapeBag::add(); src::shapes::Square::Square();
}
```

Targets are resolved with the type checker (`getResolvedSignature`, then the
symbol of the callee expression, following import and export aliases), which
is what makes the edges cross file boundaries. Constructor calls
(`new X()` → `ns::X::X()`), `super()` calls, static calls, calls through typed
object members, calls into TypeScript namespaces and calls made inside inline
callbacks are all covered.

Every call ends up in one of five buckets:

| bucket | meaning |
| --- | --- |
| resolved | the target is a declaration we translate — emitted as a call statement |
| external | the target is in `lib.d.ts` or `node_modules` (`console.log`, `Array#push`) — omitted, because Doxygen has no node for it |
| indirect | the target resolved, but to something that is not a documented entity: a function nested in another body, or a parameter or local variable holding a callback — omitted, the name would have nothing to bind to |
| unresolved | no declaration found: untyped JavaScript, `obj[name]()`, a callback the checker cannot follow — omitted |
| recursive | counted inside *resolved*, reported separately because a self-call says nothing about resolution quality |

For an overload set, the implementation signature holds the body while only
the overload signatures are callable. The extracted body is attached to the
**last overload signature**, which keeps the documented API exactly as written
and still yields the call edges.

### One declaration per output line

Doxygen 1.9.8 invents cross-references between declarations that share a
source line. `class P { public: int a(); public: void b(); };` written on one
line is reported as `P::a -> a, b`, and two inline member bodies on one line
have their calls merged into the first, losing the second one's edges.
Separators (`;;`, comments, repeated access specifiers) make no difference,
and Doxygen ignores `#line` directives in filter output, so the only cure is
to give every declaration a line of its own.

That is what the filter does, which costs the exact line number of every
declaration after the first on a compact source line:
`interface Part { start(): void; stop(): void; }` keeps its line for `Part`
but reports `start` and `stop` one and two lines further down. Code with one
declaration per line — the overwhelming majority — is unaffected: the test
suite reports **zero** drifted declarations for every fixture that is written
that way.

Constructor parameter properties are declared inside the constructor's
parameter list, so they can never have a line of their own either; they are
emitted at the end of the class body.

### Measuring the resolution rate

Add `--stats <file>` to the filter command, run Doxygen, then aggregate:

```sh
rm -f ts2doxy-stats.jsonl
# FILTER_PATTERNS = *.ts="node /abs/path/to/ts2doxy/bin/ts2doxy.js --stats ts2doxy-stats.jsonl"
doxygen Doxyfile
ts2doxy report ts2doxy-stats.jsonl
```

The report prints the declaration counts, how many declarations drifted off
their source line, the five call buckets with percentages, the resolution
rate, a sample of unresolved call sites and the files with the most of them.
`--list-unresolved` additionally marks each unresolved call site in the
generated pseudo-code with a comment, which is useful when chasing a missing
edge.

## JSDoc / TSDoc conversion

Comments are carried over with their Markdown intact (Doxygen's
`MARKDOWN_SUPPORT` handles lists, emphasis and fenced code). Characters that
mean something to Doxygen (`@`, `\`, `<`, `>`, `%`, `&`, `#`) are escaped in
prose, but three kinds of text are left exactly as written: `` `code spans` ``
and fenced blocks, the inline HTML tags Doxygen supports (`<b>`, `<i>`,
`<code>`, `<br>`, `<table>`, …) and HTML entities. So `<b>bold</b>` stays
bold while `Array<T>` in prose stays readable text.

| JSDoc / TSDoc | Doxygen |
| --- | --- |
| `@param name desc` | `@param name desc` |
| `@returns` / `@return` | `@return` (a `@returns` on a `void` function becomes a note, which Doxygen would otherwise reject) |
| `@throws {Type} desc` / `@exception` | `@throws Type desc` — the type is emitted bare, since Doxygen reads the first token as the exception object |
| `@deprecated`, `@since`, `@author`, `@version`, `@copyright`, `@date`, `@todo`, `@warning`, `@note` | the same command |
| `@see Target` | `@see ns::Target` when the checker resolves it; `@see {@link Target \| label}` becomes `@see @ref ns::Target "label"`, which renders as a link carrying that label. URLs go into the same "See also" section. A name the checker cannot resolve becomes a note, since Doxygen warns about references it cannot resolve. |
| `@example` | `@par Example` plus `@code{.js} … @endcode`; a Markdown fence inside the example is dropped, because `@code` already delimits the block |
| `@typeParam T desc` | `@tparam T desc` |
| `@remarks`, `@description`, `@summary` | an ordinary paragraph |
| `@defaultValue`, `@internal`, `@alpha`, `@beta`, `@experimental`, `@group`, `@category` | a `@note` |
| `@type`, `@class`, `@abstract`, `@static`, `@readonly`, `@override`, `@extends`, `@template`, … | dropped — the generated declaration already says it |
| any other tag | a `@note`, so nothing is lost silently |
| `{@link X}`, `{@linkcode X}`, `{@linkplain X}` | `@ref ns::X`, with the target resolved through the type checker. `{@link X \| label}` becomes `@ref ns::X "label"`. A target that does not resolve to a translated declaration is written as inline code — Doxygen warns about references it cannot resolve. |
| `{@link https://… }`, `{@link https://… \| label}` | the bare URL, or a Markdown link `[label](url)` |
| `@file`, `@fileoverview`, `@module`, `@packageDocumentation` | a `@file` block for the whole file |

The TSDoc separator in `@param name - description` and
`@typeParam T - description` is punctuation between the name and the
description, so it is dropped rather than kept as the first word of the text.

`@param` is only emitted for names that appear in the emitted signature.
Dotted names from destructured parameters (`@param options.width`) have no
counterpart there, so they are collected into a note instead of producing a
Doxygen warning about an unknown argument. The leading word of every generated
note is prefixed with `%` to stop `AUTOLINK_SUPPORT` turning boilerplate like
"Default value" into a link to a class of that name.

## Results on a real project

TypeORM 1.1.2, `packages/typeorm/src` (496 files), documented through
pre-generation mode:

* **693** classes and interfaces, 3665 methods, 3031 fields, 223 typedefs.
* **413 of 413** inheritance edges match the TypeScript source exactly —
  compared by reading `extends`/`implements` out of the TypeScript AST and
  diffing against Doxygen's XML. No missing edges, no invented ones.
* **7255** call references recorded, from 9681 emitted call statements.
* Call resolution: **57.0%** of all 16993 call sites, **92.8%** of the calls
  that go into the documented sources. The rest are calls into `lib.d.ts` and
  `node_modules` (38.6%), which can never become edges because Doxygen has no
  node for them, plus 3.1% unresolved and 1.3% indirect. The unresolved ones
  are concentrated in the database drivers and are almost all calls on
  `any`-typed client objects from optional dependencies
  (`this.client.get`, `this.redis.createClient`) — exactly the case the type
  checker cannot follow.
* **82** declarations out of ~10000 could not keep their source line, all of
  them sharing a line with another declaration.
* **8 Doxygen warnings**, none caused by the translation: eight functions in
  the two vendored MongoDB typings files document some of their parameters and
  not others, and Doxygen reports a partially documented parameter list. It
  does the same for C++ sources with the same gaps.
* A full run with HTML and Graphviz takes **75 s** on top of the 6.1 s of
  pre-generation, and produces **10514** diagrams: 764 inheritance graphs,
  1362 collaboration graphs, 4230 call graphs and 3622 caller graphs.

To reproduce, with the project checked out next to this one:

```sh
# tsconfig.json of typeorm extends @tsconfig/node20, so its deps must be there
cd typeorm/packages/typeorm && npm install
ts2doxy pregen src --out /tmp/typeorm-pregen --stats /tmp/typeorm-stats.jsonl
ts2doxy report /tmp/typeorm-stats.jsonl
# then run Doxygen over /tmp/typeorm-pregen with GENERATE_XML = YES, and:
node test/verify-project.js typeorm/packages/typeorm/src <xml-dir>
```

`test/verify-project.js` reads `extends`/`implements` out of the TypeScript
AST, reads `<basecompoundref>` out of Doxygen's XML and diffs the two, so the
claim above is checkable on any project rather than taken on trust.

## Doxygen versions

Tested against Doxygen **1.9.8** and **1.18.0**. Both produce the same
documentation from the same input; the differences below are Doxygen's, and
`ts2doxy` works around the ones it can.

The `single` namespace mode and the `none` findings below were added later
and verified on Doxygen **1.18.0 only**, not on 1.9.8.

On the 496-file project used for the measurements above, Doxygen 1.9.8 reports
7187 call references and invents none; 1.18.0 reports 7779 — the same 7187,
plus 592 parameter-name collisions (see below). Run the test suite against a
specific build with `DOXYGEN=/path/to/doxygen npm test`.

### Handled

* **A function outside a class was reported as calling itself.** Doxygen 1.18
  resolves the name in `void f() { … }` at namespace or file scope to `f`
  itself, which renders as a false recursion arrow in the call graph; methods
  are unaffected, and a separate forward declaration does not help. It
  disappears when the definition names the function with its qualifier, which
  Doxygen only accepts once it has seen a plain declaration — so a free
  function is emitted as a declaration followed by
  `ret ns::name(params) { … }`. The declaration goes on the line *above*, so
  the definition keeps the function's own source line and the reported line
  numbers are unchanged; the declaration carries the documentation. The cost
  is one line of the comment's space (see the note on comment space under
  Known limitations) and, in densely written files, one more declaration that
  cannot keep its line. A function with no body of its own — an overload
  signature or an ambient declaration — gets an empty definition for the same
  reason.
* **An unqualified type name matching the enclosing class** was resolved to
  that class's constructor, drawing a false arrow from every method returning
  `this`. TypeScript models `this` as a type parameter whose symbol is the
  class, which printed as the bare class name; it is now always qualified.
* **An unmatched backtick in a source comment** makes Doxygen 1.18 read the
  rest of the comment, its `*/` included, as a verbatim block, losing the
  declaration. Doxygen has no escape for a backtick and does not decode
  `&#96;` in prose, so a backtick left over after the paired code spans have
  been taken out is replaced by an apostrophe.

### Not worked around: `--namespace-mode none` garbles free functions

The fix above needs a qualifier for the definition. With
`--namespace-mode none` there is no namespace, so the definition is written
with the global-scope qualifier, `void ::upsertSession(string id) { … }`.
Doxygen 1.18.0 reads `void ::upsertSession` as the member `upsertSession` of
a class `void`. Every free function whose return type ends in a name comes
out garbled: `void::upsertSession`, `number::countHits`,
`Promise::upsertAll`. When the return type is a class of the project, the
function is even filed as a member of that class (`Session::findSession`),
and on a real project Doxygen has been reported to warn
`no matching class member found for void::upsertSession`. No spelling of a
global-scope definition avoids both this and the false self-reference. Tried
on 1.18.0: `void ::f`, `auto ::f(…) -> void`, `void (::f)(…)`, the return type
on its own line, a comment or `inline` between the two, `extern void ::f`,
and the unqualified `void f(…)`.

Use **`--namespace-mode single`** instead. It puts the whole project into one
namespace (named after the package, see `--namespace-name`), so free
functions can be qualified the same way as in the other modes, and their
names, return types and call graphs come out right. The test suite checks
`single` on a fixture and also asserts the `none` failure on 1.18, so a
Doxygen release that changes the behaviour is noticed.

### Not worked around: parameter-name collisions

Doxygen 1.18 turns a parameter whose name matches a documented entity into a
reference to it: `scale(number factor)` is reported as referencing the field
`factor`. Nothing is done about this, for two reasons.

The first is that for a TypeScript constructor parameter property the two
names are the *same name* — `constructor(public width: number)` declares a
parameter and a field in one breath — so there is no renaming that does not
misrepresent the code. Renaming ordinary parameters would be no better: they
are part of the documented API, and the `@param` names would have to be
renamed with them, leaving the documentation disagreeing with the source on
every Doxygen version.

The second is that the damage is small: Doxygen leaves data members out of
call and caller graphs, so these show up only as an extra entry in a
member's "References" list, never as an arrow in a diagram.

The test suite accounts for them explicitly — it knows which names were
parameters of which function — and reports how many it discounted, so the
check still fails on anything else Doxygen adds by itself.

## Troubleshooting

### `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, and “no equal sign specified for item”

```
error: Illegal format for option FILTER_PATTERNS, no equal sign ('=') specified
       for item '/abs/path/to/ts2doxy/bin/ts2doxy.js'
src/shapes.ts:3
  constructor(public width: number) {}
                     ^^^^^^^^^^^^^
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property
is not supported in strip-only mode
```

The filter command is not quoted. Doxygen splits the value of
`FILTER_PATTERNS` on whitespace, so

```
FILTER_PATTERNS = *.ts=node /abs/path/to/ts2doxy/bin/ts2doxy.js
```

becomes two items: `*.ts=node`, which makes Doxygen run plain `node` on your
TypeScript file, and the bare path, which has no `=` and produces the first
error. Node then tries to *execute* the TypeScript, and its strip-only mode
rejects any syntax it cannot erase (parameter properties, `enum`, `namespace`).
Quote the command:

```
FILTER_PATTERNS = *.ts="node /abs/path/to/ts2doxy/bin/ts2doxy.js"
```

### The filter is not found, although the same command works in your shell

Doxygen starts the filter with `/bin/sh`, not with your interactive shell, and
with the working directory you started `doxygen` in. `PATH` additions from your
shell profile, shell functions, and `node_modules/.bin` entries that your
package manager puts on `PATH` are all absent there, and an executable
`ts2doxy.js` relying on its shebang may not be found at all. Always write
`sh` or `node` plus an absolute path to the clone, and make sure `node` is on
the `PATH` that `/bin/sh` gets (the shell wrapper falls back to it).

### `Cannot find module 'typescript'`

The clone has no dependencies installed. Run `npm ci` inside the ts2doxy clone
(not in the documented project). Without it the filter fails on every file;
by default a failed file is skipped with a warning on stderr, so what you see
is a documentation build that simply contains nothing.

### `.js` / `.mjs` files come out as garbage, or as classes at global scope

Every extension listed in `FILE_PATTERNS` needs an entry in `FILTER_PATTERNS`
too. An extension that is mapped to C++ by `EXTENSION_MAPPING` but has no
filter is read by Doxygen's **C++ parser as raw JavaScript**, which does not
fail loudly — it just makes something up. For

```js
export const greet = (name) => `hi ${name}`;
export class Legacy { run() { return greet('x'); } }
```

Doxygen reports a class `Legacy` at global scope instead of in the file's
namespace, a variable `greet` of type `const`, and no call edge from
`Legacy::run` to `greet`. Keep the three lists in step:
`FILE_PATTERNS`, `EXTENSION_MAPPING` and `FILTER_PATTERNS` in `Doxyfile.sample`
all cover `ts tsx mts cts js jsx mjs cjs`.

### The call and caller graphs are empty (or full of self-references)

`SOURCE_BROWSER` must be `YES`. Doxygen only records cross-references while it
runs the source browser pass, so with `SOURCE_BROWSER = NO` every call
statement the filter emits is discarded and Doxygen puts self-references in
their place (on the test fixtures: 35 real edges gone, 25 invented ones).
`CALL_GRAPH = YES` and `CALLER_GRAPH = YES` alone are not enough.

### Types are unresolved and calls into libraries are missing

Run `npm install` in the project you are documenting. `ts2doxy` builds a real
TypeScript program with a type checker; if the project's `node_modules` is not
there, imports do not resolve, member types fall back to sanitized names, and
calls through them cannot be resolved into edges. Node's own types come from
`@types/node`, which is part of that install. A missing `tsconfig.json` has the
same effect for compiler options — pass `--project` if it is not in the usual
place.

## Known limitations

* Class fields that only exist as `this.x = …` assignments in a JavaScript
  constructor are not emitted as members (TypeScript class property
  declarations and JSDoc-typed constructor parameters are).
* CommonJS `module.exports = …` is not recognised as an export.
* Statements at module level (code outside any function) do not become call
  graph edges, because there is no function to attribute them to.
* Call statements are emitted without arguments, so a call to an overloaded
  function links to one of its overloads rather than the matching one.
* Declarations that share a source line do not keep their exact line number;
  see “One declaration per output line” above.
* Decorators are not reflected in the output.
* Doxygen's `Javascript` parser is not used at all; `.js` files go through the
  same C++ pseudo-code path as TypeScript.
* Declarations are emitted on their original source line, so a documentation
  block only has the lines the original comment occupied to live in — and the
  converted comment is often longer, because `@example` gains
  `@code`/`@endcode` wrappers and because notes about the TypeScript original
  are added. When it does not fit, the block is tightened in steps: first the
  blank lines between description, commands and notes go, then the added notes
  move onto the last comment line, then the `/**` and `*/` delimiters share
  lines with the text. Description paragraphs, Markdown lists and the line
  structure of code examples survive all of that. Only if even the tightest
  form does not fit is the comment collapsed onto one line, which costs a code
  example its line breaks. Leaving a blank line above the declaration avoids
  it.
* `@see` with a name the type checker cannot resolve becomes a note rather
  than a reference, because an unresolvable `\ref` is a Doxygen warning.
* The cache does not notice a file *appearing* outside the directories the
  tsconfig's `include` covers, at a place where module resolution only looked
  for one (for example a new `.d.ts` in `node_modules` that changes what an
  import resolves to). Changes to files that were read, `npm install`
  upgrades included, are noticed. Delete `~/.cache/ts2doxy` after
  restructuring dependencies by hand.

## Development

```sh
npm ci
npm test            # translation checks + Doxygen integration (if doxygen is on PATH)
```

The fixtures in `test/fixtures/src` cover every mapping rule above;
`test/fixtures/Doxyfile` is a copy of `Doxyfile.sample` wired to the checkout
(through the shell wrapper, so the Doxygen checks exercise it).
`test/fixtures-modes` holds the free-function fixture for the `single` and
`none` namespace modes, with one Doxyfile per mode that includes the main one.
Pick the Doxygen build with `DOXYGEN=/path/to/doxygen npm test`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
