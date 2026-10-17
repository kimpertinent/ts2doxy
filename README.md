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
* Doxygen ≥ 1.9 (developed against 1.9.8)
* Graphviz (`dot`) for the diagrams (developed against 2.43)

The only runtime dependency is the `typescript` package (Apache-2.0); `ts2doxy`
uses its Compiler API **including the type checker**, which is what makes
cross-file inheritance and call resolution possible.

## Installation

```sh
# inside the project you want to document
npm install --save-dev ts2doxy
```

Or from a checkout:

```sh
git clone https://github.com/kimpertinent/ts2doxy
cd ts2doxy && npm install
```

## Usage

### As a Doxygen filter

Copy `Doxyfile.sample` into your project, point `INPUT` at your sources and
run `doxygen`. The three settings that do the work:

```
EXTENSION_MAPPING   = ts=C++ tsx=C++ mts=C++ cts=C++ js=C++ jsx=C++ mjs=C++ cjs=C++
FILE_PATTERNS       = *.ts *.tsx *.mts *.cts *.js *.jsx *.mjs *.cjs
FILTER_PATTERNS     = *.ts="node ./node_modules/ts2doxy/bin/ts2doxy.js" ...
FILTER_SOURCE_FILES = NO
```

`Doxyfile.sample` is commented; the settings worth knowing about are:

| Setting | Why |
| --- | --- |
| `EXTENSION_MAPPING = ts=C++` | Doxygen has no TypeScript parser. Its built-in `Javascript` parser does not produce class, inheritance or call graphs, which is the whole point of this filter. |
| `FILTER_SOURCE_FILES = NO` | Keeps the source browser showing the original TypeScript. The filter preserves line numbers, so references still land correctly. |
| `EXTRACT_ALL = YES` | Undocumented declarations are translated too; this makes them appear, and keeps call graphs complete. |
| `ENABLE_PREPROCESSING = NO` | The pseudo-code contains no preprocessor directives. (Doxygen 1.9.8 ignores `#line` directives, which is why line numbers are preserved by layout instead.) |
| `BUILTIN_STL_SUPPORT = YES` | TypeScript function types are emitted as `std::function<...>`; this stops Doxygen documenting those as user classes. |
| `INCLUDE_GRAPH`/`INCLUDED_BY_GRAPH = NO` | No `#include` directives are emitted, so those graphs would always be empty. |
| `UML_LIMIT_NUM_FIELDS = 0`, `DOT_UML_DETAILS = YES` | Show all members with their types inside the UML boxes. |

### On the command line

```sh
ts2doxy src/thing.ts            # print the translation of one file
ts2doxy --stats stats.jsonl src/thing.ts
ts2doxy --help
```

Options:

| Option | Meaning |
| --- | --- |
| `-p, --project <tsconfig>` | tsconfig to use. Default: nearest `tsconfig.json`/`jsconfig.json` walking up from the input file. |
| `-r, --root <dir>` | Directory namespaces are derived from. Default: `rootDir` from the tsconfig, else the tsconfig's directory, else the nearest `package.json` directory. |
| `-n, --namespace-mode <m>` | `path` (default), `flat` (one namespace per file) or `none`. |
| `--whole-program` | Build the `Program` from the full tsconfig file list instead of just the input file's import closure. Slower; needed only when symbols are shared through globals rather than imports. |
| `--no-implicit-ctors` | Do not synthesize constructors for classes that declare none. |
| `--no-virtual` | Do not mark instance methods `virtual`. |
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
| overloads | one declaration each |
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

Names that collide with a C++ keyword get a trailing underscore
(`const double = …` becomes `number double_(…)`), because the output has to go
through a C++ parser.

Instance methods are marked `virtual` by default: every TypeScript method is
dynamically dispatched, and it makes Doxygen show “Implements” /
“Reimplemented from” links. Use `--no-virtual` to turn that off.

Classes that declare no constructor get a synthesized one, documented as such.
Without it Doxygen has no node to draw `new Foo()` call edges to. Use
`--no-implicit-ctors` to turn that off.

## Known limitations

* Class fields that only exist as `this.x = …` assignments in a JavaScript
  constructor are not emitted as members (TypeScript class property
  declarations and JSDoc-typed constructor parameters are).
* CommonJS `module.exports = …` is not recognised as an export.
* Statements at module level (code outside any function) do not become call
  graph edges.
* Decorators are not reflected in the output.
* Doxygen's `Javascript` parser is not used at all; `.js` files go through the
  same C++ pseudo-code path as TypeScript.

## Development

```sh
npm install
npm test            # translation checks + Doxygen integration (if doxygen is on PATH)
```

The fixtures in `test/fixtures/src` cover every mapping rule above;
`test/fixtures/Doxyfile` is a copy of `Doxyfile.sample` wired to the checkout.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
