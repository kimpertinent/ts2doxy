# Task: Make Doxygen document TypeScript (and JavaScript) via an input filter

## Goal
Build a Doxygen input filter that lets Doxygen produce full documentation for TypeScript/JavaScript projects, including the features TypeDoc lacks:
- proper UML class diagrams
- inheritance diagrams
- call graphs and caller graphs

Doxygen itself is not modified. The filter translates TS/JS source into C++-like pseudo-code that Doxygen parses natively.

## Background
- Doxygen's `INPUT_FILTER` / `FILTER_PATTERNS` run `<filter> <input-file>` and parse the filter's stdout instead of the original file.
- The same mechanism is used by doxypypy for Python.
- Doxygen draws class, inheritance and collaboration diagrams from C++ class declarations, and call/caller graphs from function bodies (via Graphviz `dot`).
- Transpiling TS to real C++ was considered and rejected: it does not preserve documentation structure.

## Approach
- Node.js script using the **TypeScript Compiler API** (`typescript` package), including the **type checker**, so calls and types can be resolved across files.
- Load the project's `tsconfig.json` (walk up from the input file) to build the `Program`. JS files: use `allowJs`/`checkJs`-style settings when no tsconfig exists.
- Because Doxygen calls the filter once per file, evaluate whether per-file invocation is fast enough. If not, add an alternative **pre-generation mode** that writes a mirror tree of translated files in one pass, and Doxygen runs on that tree instead. Report the measured timings before choosing.
- Preserve line numbers of declarations where feasible, so Doxygen's source references point to the right lines.

## Mapping rules (TS → Doxygen-parseable C++)
- Module/file → `namespace` derived from the file path.
- `class` → `class`; `extends` / `implements` → `public` inheritance.
- `interface` → `class` with pure virtual methods and public members.
- `abstract` methods → pure virtual; `static` → `static`; `readonly` → `const`.
- `public` / `protected` / `private` / `#private` → corresponding C++ access sections.
- Generics → `template<typename T, ...>`; constraints go into the doc comment.
- Functions, including arrow functions assigned to `const` → free functions.
- Overloads → multiple declarations.
- `enum` → `enum class`.
- `type` aliases → `typedef`, with the original TS type text kept in the documentation.
- Complex types (unions, intersections, mapped, conditional, literal types) → a sanitized identifier in the signature, plus the original TS type text in the doc block. Never emit syntax that breaks Doxygen's parser.
- Default / named exports → mark in documentation.

## JSDoc / TSDoc → Doxygen
- `@param`, `@returns` → `@return`, `@throws`, `@deprecated`, `@see`, `@since`.
- `@example` → `@code ... @endcode`.
- `{@link X}` → `\ref` with the resolved qualified name, or plain text if unresolvable.
- Undocumented items still appear (works with `EXTRACT_ALL`).

## Call graphs (the critical part)
- For every function/method, emit a simplified body containing **only the calls it makes**, written as **fully qualified** C++ calls (`ns::Class::method();`, `ns::freeFunction();`).
- Resolve call targets with the type checker (`getResolvedSignature`, `getSymbolAtLocation`, follow aliases/imports).
- Include constructor calls (`new X()` → `ns::X::X();`), method calls on typed objects, static calls, `super` calls.
- Calls that cannot be resolved (untyped JS, `obj[name]()`, callbacks passed around) → omit, optionally list them in a comment. Count them and report the resolution rate per project.

## Doxyfile
Provide a sample `Doxyfile` with at least:
`EXTENSION_MAPPING` (ts, tsx, js, jsx, mts, cts → C++), `FILE_PATTERNS`, `FILTER_PATTERNS` or `INPUT_FILTER`, `HAVE_DOT = YES`, `UML_LOOK = YES`, `CLASS_GRAPH`, `COLLABORATION_GRAPH`, `CALL_GRAPH = YES`, `CALLER_GRAPH = YES`, `EXTRACT_ALL`, `EXTRACT_PRIVATE`, `EXTRACT_STATIC`, `RECURSIVE = YES`. Explain any setting that is non-obvious.

## Testing
1. Small fixture files covering every mapping rule above.
2. One medium-sized real open-source TypeScript project as a realistic test.
Acceptance criteria:
- Inheritance and UML class diagrams match the actual class hierarchy.
- Call/caller graphs are correct for typed TS methods; resolution rate reported.
- Doxygen runs without parser errors caused by the filter output.

## Deliverables
- Filter script (Node.js) with `package.json`
- Sample `Doxyfile`
- Fixture files
- Short README: installation, usage, known limitations

## Working rules
- Dependencies: FOSS only.
- Work in phases: (1) declarations + inheritance diagrams, (2) JSDoc conversion, (3) call graphs, (4) performance / pre-generation mode. Show results after each phase.
- Ask before deviating from this plan or adding features not listed here.

---

# Progress

## Environment

Doxygen 1.9.8, Graphviz 2.43.0, Node.js 22, `typescript` 5.9.3 (pinned to 5.x:
the 7.x native port does not expose the full Compiler API used here).

Finding that shaped the design: **Doxygen 1.9.8 ignores `#line` directives in
filter output** (verified by feeding it `#line 100 "orig.ts"` and reading the
`<location line="...">` from the XML — it reported the physical line). Line
numbers are therefore preserved by *layout*: every declaration is emitted on
its original source line, and doc blocks are shrunk to fit the free space above
it (`src/canvas.js`). With `FILTER_SOURCE_FILES = NO` Doxygen then shows the
real TypeScript and its line references are correct.

## Phase 1 — declarations + inheritance diagrams: done

Delivered:

* `bin/ts2doxy.js` — CLI / filter entry point. Never writes anything but
  pseudo-code to stdout, and skips a file with a warning instead of aborting a
  documentation build (`--strict` to opt out).
* `src/` — `project.js` (tsconfig discovery, `Program` creation),
  `names.js` (path → namespace, C++ identifier sanitization),
  `symbols.js` (qualified names, shared by inheritance and call resolution),
  `types.js` (TS type → Doxygen-parseable type), `doc.js` + `jsdoc.js`
  (comment blocks, escaping), `canvas.js` (line-anchored output),
  `translate.js` (the emitter).
* `Doxyfile.sample` — commented, every non-obvious setting explained.
* `test/fixtures/src/{shapes,types,functions,app}.ts`, `legacy.js` — cover
  every mapping rule in the task.
* `test/run.js` — 88 checks: translation assertions per mapping rule, zero
  line drift, balanced braces, plus a Doxygen integration run.
* `README.md`.

Results (`npm test`): **88 checks passed, 0 failed**.

* Doxygen run over the fixtures: **no warnings, no parser errors**
  (`doxygen-warnings.log` empty), 7.9 s, 67 SVG diagrams.
* Inheritance extracted exactly as written in the TypeScript, e.g.
  `Rectangle : AbstractShape, Drawable`, `Square : Rectangle`,
  `AbstractShape : Shape`, `NamedAndIdentified : Named, Identified`.
* Declaration line numbers match the TypeScript source exactly
  (drift 0 on all five fixtures).
* UML class diagram for `Rectangle` shows the full hierarchy with typed fields
  and operations (`virtual number area()`, `static number instances`, …).
* Cross-file type references are fully qualified
  (`src::types::Comparator< T >`), so collaboration graphs link up.

Decisions taken inside the plan (all documented in the README):

* Primitive names are kept as written in TypeScript (`number`, `string`,
  `boolean`) rather than being mapped to `double`/`std::string` — they are
  legal C++ identifiers and claiming `number` is a `double` would mislead.
* Instance methods are emitted `virtual` (TypeScript dispatch is dynamic; it
  also makes Doxygen show “Reimplemented from”). `--no-virtual` disables it.
* Classes without an explicit constructor get a synthesized one, documented as
  such, so that `new Foo()` call edges have a target. `--no-implicit-ctors`
  disables it.
* `T | null` / `T | undefined` collapse to `T` so the member still links to
  `T`; the original union is in the doc block.

## Phase 2 — JSDoc/TSDoc conversion: not started

## Phase 3 — call graphs: not started

## Phase 4 — performance / pre-generation mode: not started
