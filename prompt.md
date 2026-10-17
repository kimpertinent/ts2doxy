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
- After each phase, stop and wait for my approval before starting the next one.
- Ask before deviating from this plan or adding features not listed here.
- Commit as `Kimpertinent <kimpertinent13@gmail.com>`; set it per repository with
  `git config user.name "Kimpertinent"` and
  `git config user.email "kimpertinent13@gmail.com"` before committing, and use
  it for every commit. Work directly on `main` and push to `main`.

---

# Progress

## Environment

Doxygen 1.9.8 and 1.18.0 (built from source), Graphviz 2.43.0, Node.js 22, `typescript` 5.9.3 (pinned to 5.x:
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

Results (`npm test`): **88 checks passed, 0 failed**. (Superseded by the
review fixes below: 229 checks.)

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

### Phase 1 review fixes: done

1. **Access leak.** A `private` constructor parameter property emitted a bare
   `private:` section on the constructor's line, so every member after it was
   reported private (`Circle.area` among them). Access is no longer tracked as
   state: every class member now carries its own explicit specifier, because
   members with different access can legitimately share an output line.
   New test compares each member's protection in Doxygen's XML against a
   hand-written table derived from the TypeScript source — hand-written on
   purpose, so it does not just re-run the emitter's own logic.
2. **Overload signatures were pure virtual.** A method is now `= 0` only when
   it is `abstract` or an interface member; a body-less method is an overload
   signature or an ambient declaration and is emitted as a plain declaration.
   The implementation signature is no longer emitted as an extra overload
   (it is not callable, and its parameter types are the union of all
   overloads) — except that parameter properties declared on it are still
   emitted, since TypeScript only allows them there.
   *Open question for phase 3:* the implementation signature is the only one
   with a body, i.e. the only source of call-graph edges. The plan is to
   attach the extracted call body to the **last overload signature** (which
   keeps the documented API exactly as written while preserving call edges).
   Say the word if you would rather have the implementation documented as an
   extra (e.g. private) member instead.
3. **Inferred types lost type arguments.** `new Map<string, number>()` came
   out as `Map< string >`, because the printed type was re-parsed with a
   regex that stopped at the first comma. Checker types are now mapped
   structurally (unions, intersections, aliases, enums, generic references),
   so type arguments and qualified names survive:
   `Map< string, number >`, `Set< Promise< string > >`,
   `Map< string, src::shapes::Circle >`. The remaining text fallback got a
   nesting-aware splitter as well.
4. **`GENERATE_XML = YES`** in `Doxyfile.sample`, with `XML_PROGRAMLISTING`
   and a note that the embedded listing is the original TypeScript.
5. **Working rules** in this file now say to stop for approval after each
   phase.

New fixtures: `test/fixtures/src/overloads.ts` (method and constructor
overloads, an ambient `declare class`) and `inference.ts` (annotation-free
declarations whose types come from the checker).

Results after the fixes (`npm test`): **229 checks passed, 0 failed**;
Doxygen still runs with an empty warning log.

Phase 1 approved at review. For overloads the **last-overload approach** is
approved: in phase 3 the extracted call body will be attached to the last
overload signature, keeping the documented API as written while preserving the
call edges. The unfinished phase-2 draft that existed at review time was
pushed to the branch `wip-phase2` for safekeeping.

## Phase 2 — JSDoc/TSDoc conversion: done

`src/jsdoc.js` converts comments; `src/doc.js` assembles and escapes the
blocks. Two rules drive it: nothing may provoke a Doxygen warning (a warning
caused by the filter is a bug), and nothing may be dropped silently (tags
without a Doxygen counterpart become `@note`s).

Converted: `@param`, `@returns`/`@return`, `@throws`/`@exception`,
`@deprecated`, `@see`, `@since`, `@example` → `@code{.js} … @endcode`,
`@typeParam` → `@tparam`, `@remarks`, `@defaultValue`, `@internal`, `@group`,
the pass-through set (`@author`, `@version`, `@copyright`, `@date`, `@todo`,
`@warning`, `@note`), and `{@link}`/`{@linkcode}`/`{@linkplain}` →
`@ref <qualified name>` resolved through the type checker. Tags the generated
declaration already expresses (`@type`, `@abstract`, `@static`, …) are
dropped; anything else becomes a `@note`. Markdown survives; Doxygen-special
characters are escaped in prose but left verbatim in code spans and fences.

Results (`npm test`): **305 checks passed, 0 failed**, Doxygen's warning log
still empty. Verified in Doxygen's XML that the conversions actually resolve:
`{@link Circle}` → `<ref refid="classsrc_1_1shapes_1_1Circle">`,
`{@link Circle.area | the area method}` → a member ref with that label,
`@param` → `<parameterlist kind="param">`, `@throws RangeError` →
`<parameterlist kind="exception">` with `RangeError` as the exception object,
`@deprecated` → `<xreftitle>Deprecated</xreftitle>`, `@since` →
`<simplesect kind="since">`, `@typeParam` →
`<parameterlist kind="templateparam">`, `@example` →
`<programlisting filename=".js">`, Markdown list → `<itemizedlist>`.

New fixture `test/fixtures/src/docs.ts` covers every tag plus the inline-link
forms that must *not* become references.

Four things the task did not anticipate, found by running Doxygen rather than
by reading its documentation:

1. **`@par <title>` takes the rest of the line as its title**, and a command
   inside a title is rejected ("Illegal command @note found as part of a title
   section"). This only showed up when a comment had to be collapsed onto one
   line to fit above its declaration. Collapsing now demotes a `@par` heading
   to plain text, and the "parameters not in the signature" list became a
   single `@note` rather than a `@par` list, so a collapsed `@return`
   description can no longer swallow it.
2. **An unresolvable `\ref` is a warning.** `{@link}` targets are resolved
   through the type checker first and only emitted as `@ref` when they name a
   declaration we translate; the rest become inline code or a plain URL. Same
   reasoning for `@see` (unresolvable → note) and `@param` (a name that is not
   in the emitted signature → note).
3. **`@returns` on a `void` function** is rejected, so it becomes a note.
4. **`AUTOLINK_SUPPORT` links generated boilerplate.** The word "Documented"
   in a generated note turned into a link to the fixture's `Documented` class.
   The leading word of every generated note now carries a `%` prefix, which
   suppresses that.

Also fixed on the way: `Doc` entries are split on newlines, because the canvas
budgets space by counting entries — an entry containing a newline made it
under-count the lines a comment block needs.

### Phase 2 review fixes: done

1. **Comments were collapsed although there was room.** The converted comment
   is usually longer than the original (`@example` gains `@code`/`@endcode`
   wrappers, notes about the TypeScript original are appended), and the canvas
   collapsed the whole block onto one line as soon as it did not fit — losing
   paragraphs, Markdown lists and, in `describeCircle`, a two-line example
   that came out as a single `<codeline>`. `Doc` now offers a ladder of
   renderings and the canvas takes the most faithful one that fits: blank
   separators go first, then the added notes move onto the last comment line,
   then the `/**` and `*/` delimiters share lines with the text. Collapsing is
   the last resort. `describeCircle` now yields **3 `<codeline>`s, 1
   `<itemizedlist>` with 2 `<listitem>`s and 8 `<para>`s**; new tests assert
   those counts in the XML.
2. **`@see https://example.com/docs` lost its scheme.** TypeScript parses the
   argument of `@see` into `tag.name` plus `tag.comment` and splits a URL
   between them (`name = "https"`, comment = `"://example.com/docs"`); only
   the comment was read. Both halves are now rejoined before anything looks
   at them. Two further `@see` bugs came out of the same fixture: `@see Name`
   was **dropped entirely** (its text lives in `tag.name`, which was never
   read — `@see` had no fixture coverage in phase 2), and TypeScript hands
   over the leading `*` of the next comment line as the tag's description,
   which was being printed.
3. **`{@link https://example.com | Docs}`** now becomes the Markdown link
   `[Docs](https://example.com)`, which Doxygen renders as
   `<ulink url="https://example.com">the docs</ulink>`.
4. **Inline HTML was escaped.** Escaping now skips the HTML tags Doxygen
   supports and HTML entities, so `<b>`, `<i>`, `<code>` and `<br>` render as
   markup (`<bold>`, `<emphasis>`, `<computeroutput>`, `<linebreak/>` in the
   XML) while `Array<T>` in prose stays escaped text.
5. **TSDoc `@param name - description`** keeps the hyphen no longer; it is the
   separator between name and description, not part of it. Same for
   `@typeParam T - description`.

Results (`npm test`): **337 checks passed, 0 failed**; Doxygen's warning log
still empty and declaration line numbers still exact.

### Phase 2 second review fixes: done

1. `@see {@link X | label}` kept the `@ref` out of the output, leaving
   `@see ns::X "label"` — Doxygen printed the label as text next to the name.
   The `@ref` is now kept (`@see @ref ns::X "label"`), which renders as a
   link carrying the label.
2. `@see <URL>` now goes into the "See also" section rather than a note.
   Checked against Doxygen first: a bare URL, a Markdown link and
   `@see @ref x "label"` are all accepted there without warnings. A labelled
   URL written as `@see {@link https://… | label}` lands there too; that form
   needed a fix in the raw-text reassembly, which was inserting a space
   between the `https` scheme and the rest.

Still **0 Doxygen warnings**; `npm test`: **343 checks passed, 0 failed**.

## Phase 3 — call graphs: done

`src/calls.js` extracts the calls a function makes; each becomes a fully
qualified call statement in the emitted body, on the line of the original
call. Targets are resolved with `getResolvedSignature`, then the symbol of the
callee expression with import/export aliases followed. Covered: constructor
calls (`new X()` → `ns::X::X();`), `super()` (also to a synthesized
constructor), static calls, calls through typed members, calls into TypeScript
namespaces, generic and interface members, overloads, recursion, and calls
inside inline callbacks. As approved, the body of an overload set sits on its
last overload signature.

Every call lands in one bucket: resolved (emitted), external (`lib.d.ts` /
`node_modules`), indirect (resolves to something Doxygen has no node for),
unresolved, and recursive (counted inside resolved). `--stats` writes
per-file statistics, `ts2doxy report` aggregates them, `--list-unresolved`
marks unresolved call sites in the output.

Fixtures: 56 calls, 36 resolved (64.3%), 92.3% of the calls into the
documented sources; the rest is deliberate (an `any` receiver, a nested
function, a callback parameter).

### Phase 3 review fixes: done

Doxygen 1.9.8 invents cross-references between declarations that share an
output line, and merges the bodies of inline members on one line. No
separator helps and `#line` is ignored, so every declaration now starts its
own output line (closing braces and call statements still share);
constructor parameter properties go to the end of the class body. A new edge
test compares, by refid, every `<references>` in Doxygen's XML with the edges
the filter wrote, in both directions; the new compact fixture
(`compact.ts`) made it catch 6 invented edges. `SOURCE_BROWSER = YES` turned
out to be required (with `NO` all real edges vanish and bogus ones appear);
documented in README and `Doxyfile.sample`.

## Phase 4 — performance / pre-generation mode: done

Measured first: one filter run is nine tenths fixed cost (199 ms module load,
345 ms program, 115 ms checker, 89 ms translation), and Doxygen filters each
file more than once. On TypeORM 1.1.2 (`packages/typeorm/src`, 496 files,
Doxygen 1.9.8, XML, no dot): per-file filtering 1697 s, `ts2doxy pregen`
6.1 s + 4 s of Doxygen. `pregen` builds one program for the tree and writes a
mirror of translated files; its output is byte-identical to per-file mode
(asserted per fixture). Per-file filtering stays the default because it keeps
the real TypeScript in the source browser.

Real-project results: 693 classes/interfaces, 413 of 413 inheritance edges
matching the source (`test/verify-project.js` diffs the TS AST against
Doxygen's XML), 7255 call references, 57.0% of all call sites resolved and
92.8% of those into the documented sources. Doxygen warnings went from 78 to
8, none caused by the translation; the fixes (nested comments in embedded
source text, backticks replaced by `<tt>`, explicit `@brief`, labelled `@ref`,
merged duplicate overload signatures, destructured parameter names) are in the
phase 4 commit and the README.

## Doxygen 1.18.0 support: done

Doxygen 1.18.0 was built from source (tag `Release_1_18_0`) and is selected
with `DOXYGEN=/path/to/doxygen npm test`. Handled: 1.18 reports every free
function as calling itself, so a free function is emitted as a declaration on
the line above plus a qualified definition (`ret ns::name(...) { ... }`) on its
own line; the `this` type is always qualified (it had produced false edges to
the class's constructor); an unmatched backtick in a comment is replaced by an
apostrophe. Not worked around, and documented: 1.18 turns a parameter whose
name matches a documented entity into a reference (the edge test accounts for
these). On TypeORM, 1.9.8 reports 7187 call references and invents none; 1.18
reports the same 7187 plus 592 parameter-name collisions.

## Installation fix: done

`npm install --save-dev ts2doxy` returns 404 (not on npm) and current npm
refuses git dependencies. README and `Doxyfile.sample` now describe the
working path: clone, `npm ci` inside the clone, and `FILTER_PATTERNS` pointing
at the clone with a quoted command and an absolute path. A troubleshooting
section covers an unquoted filter command (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`),
a filter found only by the interactive shell (Doxygen uses `/bin/sh`),
`Cannot find module 'typescript'`, unfiltered `.js`/`.mjs` files,
`SOURCE_BROWSER = NO`, and a documented project without `npm install`.

## Namespace mode `single`: done

`--namespace-mode none` is broken on Doxygen 1.18.0: the global-scope
definition `void ::upsertSession(...)` is read as a member of a class `void`
(`void::upsertSession`, `number::countHits`, `Session::findSession` filed
under the class). Eight spellings were tried; none avoids both this and the
self-reference. New `--namespace-mode single` puts the whole project into one
namespace, named after the `name` in the `package.json` next to the tsconfig
(`@scope/pkg` → `scope_pkg`), else the tsconfig directory name;
`--namespace-name` overrides it. `none` is unchanged and documented as broken
on 1.18, with `single` as the recommended alternative. An unknown mode is now
rejected. Fixture `test/fixtures-modes` runs Doxygen in both modes: `single`
must give correct names, definition lines and exactly the written calls with
no warnings; on 1.18 the `none` run asserts the garbled name so a Doxygen
change gets noticed.

`npm test` against 1.18.0: **488 checks passed, 0 failed**. This round
(`single` mode and the `none` findings) was verified on Doxygen 1.18.0 only.
