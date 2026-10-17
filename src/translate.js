'use strict';
/**
 * The translator: one TypeScript/JavaScript source file in, one stream of
 * Doxygen-parseable C++ pseudo-code out.
 *
 * Structure of the output for `src/util/text.ts`:
 *
 *     namespace src { namespace util { namespace text {
 *     ... declarations, each on its original source line ...
 *     } } }
 *     /** @file *\/
 *
 * The `@file` block is a structural command, so it works at the end of the
 * output and does not have to compete for line 1 with the namespace opener.
 */

const ts = require('typescript');
const { Canvas } = require('./canvas');
const { escapeInlineCode } = require('./doc');
const { buildDoc, findFileComment } = require('./jsdoc');
const { namespaceSegmentsForFile, sanitizeIdentifier } = require('./names');
const { nameText } = require('./symbols');
const {
  mapCheckerType, mapHeritageName, mapInferredType, mapTypeNode, typeSourceText,
} = require('./types');

/** Modifier flags we query repeatedly. */
const MF = ts.ModifierFlags;

class Translator {
  /**
   * @param {ts.SourceFile} sourceFile file to translate
   * @param {object} ctx `{program, checker, rootDir, namespaceMode, options}`
   */
  constructor(sourceFile, ctx) {
    this.sf = sourceFile;
    this.ctx = { ...ctx, sourceFile };
    this.opts = ctx.options || {};
    this.canvas = new Canvas();
    this.stats = {
      file: sourceFile.fileName,
      classes: 0,
      interfaces: 0,
      enums: 0,
      typedefs: 0,
      functions: 0,
      methods: 0,
      fields: 0,
      variables: 0,
      namespaces: 0,
      calls: { total: 0, resolved: 0, external: 0, unresolved: 0, samples: [] },
    };
    this.exports = collectExports(sourceFile);
    this.lineCount = sourceFile.getLineStarts().length;
    // Keep the module overview out of the first declaration's documentation.
    this.fileComment = findFileComment(sourceFile);
    this.ctx.skipJsDoc = new Set(this.fileComment ? [this.fileComment] : []);
  }

  /* ------------------------------------------------------------------ *
   * line helpers
   * ------------------------------------------------------------------ */

  lineOf(pos) {
    const clamped = Math.max(0, Math.min(pos, this.sf.end));
    return this.sf.getLineAndCharacterOfPosition(clamped).line + 1;
  }

  /** The line a declaration should be anchored to (its name, not its JSDoc). */
  anchorOf(node) {
    const target = node.name && node.name.getStart ? node.name : node;
    try {
      return this.lineOf(target.getStart(this.sf, /* includeJsDoc */ false));
    } catch {
      return this.lineOf(target.pos);
    }
  }

  /** The line holding the closing brace of a block-like declaration. */
  endLineOf(node) {
    return this.lineOf(Math.max(node.end - 1, node.pos));
  }

  /* ------------------------------------------------------------------ *
   * entry point
   * ------------------------------------------------------------------ */

  translate() {
    const segments = namespaceSegmentsForFile(
      this.sf.fileName, this.ctx.rootDir, this.ctx.namespaceMode,
    );
    this.namespaceSegments = segments;
    if (segments.length) {
      this.canvas.put(1, segments.map((s) => `namespace ${s} {`).join(' '));
      this.stats.namespaces = segments.length;
    }

    this.emitStatements(this.sf.statements);

    if (segments.length) {
      this.canvas.put(
        this.lineCount + 1,
        new Array(segments.length).fill('}').join(' '),
        null,
        { shared: true },
      );
    }
    this.emitFileDoc();

    const text = this.canvas.render();
    this.stats.drift = this.canvas.drift;
    return { text, stats: this.stats };
  }

  /** `@file` is a structural command, so it can be emitted last. */
  emitFileDoc() {
    const lines = ['@file'];
    if (this.fileComment) {
      const doc = buildDoc({ jsDoc: [this.fileComment] }, { ...this.ctx, skipJsDoc: null }, {});
      for (const line of doc.text) lines.push(line);
      for (const line of doc.commands) lines.push(line);
      for (const line of doc.notes) lines.push(line);
    }
    if (this.namespaceSegments && this.namespaceSegments.length) {
      lines.push(`@note Declarations of this module live in namespace ${escapeInlineCode(this.namespaceSegments.join('::'))}.`);
    }
    this.canvas.put(
      this.lineCount + 2,
      ['/**', ...lines.map((l) => (l ? ` * ${l}` : ' *')), ' */'].join('\n'),
    );
  }

  /* ------------------------------------------------------------------ *
   * statements
   * ------------------------------------------------------------------ */

  emitStatements(statements) {
    const implementations = overloadImplementations(statements);
    for (const st of statements) {
      if (implementations.has(st)) continue; // overload implementation signature
      this.emitStatement(st);
    }
  }

  emitStatement(st) {
    if (ts.isClassDeclaration(st)) return this.emitClassLike(st, 'class');
    if (ts.isInterfaceDeclaration(st)) return this.emitClassLike(st, 'interface');
    if (ts.isEnumDeclaration(st)) return this.emitEnum(st);
    if (ts.isTypeAliasDeclaration(st)) return this.emitTypeAlias(st);
    if (ts.isFunctionDeclaration(st)) return this.emitFunction(st);
    if (ts.isVariableStatement(st)) return this.emitVariableStatement(st);
    if (ts.isModuleDeclaration(st)) return this.emitModule(st);
    return undefined;
  }

  /* ------------------------------------------------------------------ *
   * classes and interfaces
   * ------------------------------------------------------------------ */

  emitClassLike(node, kind, nameOverride) {
    const name = nameOverride
      || (node.name ? nameText(node.name) : this.anonymousName(node));
    const isInterface = kind === 'interface';
    const abstract = !isInterface && hasFlag(node, MF.Abstract);

    const previousType = this.ctx.currentTypeName;
    this.ctx.currentTypeName = name;
    this.lossy = false;

    const bases = [];
    for (const clause of node.heritageClauses || []) {
      for (const type of clause.types) {
        bases.push(`public ${mapHeritageName(type, this.ctx)}`);
      }
    }

    const notes = [];
    if (isInterface) notes.push('@note TypeScript `interface`: all members are public and abstract.');
    if (abstract) notes.push('@note TypeScript `abstract class`.');
    const exported = this.exportNote(node, name);
    if (exported) notes.push(exported);
    for (const extra of this.typeParameterNotes(node)) notes.push(extra);

    const doc = buildDoc(node, this.ctx, {
      notes,
      typeParamNames: this.typeParamNames(node),
    });
    const template = this.templatePrefix(node);
    const code = `${template}class ${name}${bases.length ? ` : ${bases.join(', ')}` : ''} {`;
    this.canvas.put(this.anchorOf(node), code, doc.render());

    this.emitMembers(node, { name, isInterface, abstract });
    this.canvas.put(this.endLineOf(node), '};', null, { shared: true });

    this.ctx.currentTypeName = previousType;
    this.stats[isInterface ? 'interfaces' : 'classes']++;
  }

  /** Emit the body of a class or interface, with an access specifier on
   * every member.
   *
   * The specifier is repeated rather than tracked as state: members whose
   * access differs can share an output line (a constructor and the parameter
   * properties it declares), and a stale `private:` section would then make
   * Doxygen report the following members with the wrong protection.
   */
  emitMembers(node, info) {
    const members = node.members || [];
    // In an overload set TypeScript's implementation signature is not part of
    // the API -- only the overload signatures are callable -- so it is not
    // emitted as a declaration of its own.
    const implementations = overloadImplementations(members);
    let sawConstructor = false;

    for (const member of members) {
      const access = info.isInterface ? 'public' : accessOf(member);
      const prefix = `${access}: `;
      if (ts.isConstructorDeclaration(member)) {
        sawConstructor = true;
        if (implementations.has(member)) {
          // Parameter properties are only allowed on the implementation, so
          // the fields it declares still have to be emitted.
          this.emitParameterProperties(member, info);
        } else {
          this.emitConstructor(member, info, prefix);
        }
      } else if (implementations.has(member)) {
        continue;
      } else if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
        this.emitMethod(member, info, prefix);
      } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
        this.emitProperty(member, info, prefix);
      } else if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
        this.emitAccessor(member, info, prefix);
      } else if (ts.isIndexSignatureDeclaration(member)) {
        this.emitIndexSignature(member, info, prefix);
      } else if (ts.isCallSignatureDeclaration(member)) {
        this.emitCallSignature(member, info, prefix);
      } else if (ts.isConstructSignatureDeclaration(member)) {
        this.emitConstructSignature(member, info, prefix);
      }
    }

    // `new Foo()` is extremely common even when the class declares no
    // constructor. Without a declared constructor Doxygen has no node to draw
    // the call edge to, so synthesize one (disable with --no-implicit-ctors).
    if (!sawConstructor && !info.isInterface && this.opts.implicitCtors !== false) {
      const doc = ['/** Implicitly declared constructor (not written in the TypeScript source). */'];
      this.canvas.put(
        this.endLineOf(node),
        `public: ${info.name}();`,
        doc,
        { shared: true },
      );
    }
  }

  emitConstructor(node, info, prefix) {
    const params = this.paramList(node);
    const notes = [];
    if (this.signatureNote(node)) notes.push(this.signatureNote(node));
    const doc = buildDoc(node, this.ctx, {
      notes,
      paramNames: this.lastParamNames,
      returnsVoid: true,
    });
    const body = this.bodyFor(node, `${info.name}`);
    this.canvas.put(
      this.anchorOf(node),
      `${prefix}${info.name}(${params})${body.open}`,
      doc.render(),
    );
    this.closeBody(node, body);
    this.stats.methods++;
    this.emitParameterProperties(node, info);
  }

  /** `constructor(private x: number)` declares a field as well as a parameter. */
  emitParameterProperties(node, info) {
    for (const p of node.parameters) {
      if (ts.getCombinedModifierFlags(p) & (MF.Private | MF.Protected | MF.Public | MF.Readonly)) {
        this.emitParameterProperty(p, info);
      }
    }
  }

  emitParameterProperty(p, info) {
    const type = this.mapType(p.type, p);
    const name = ts.isIdentifier(p.name) ? nameText(p.name) : 'field';
    const konst = (ts.getCombinedModifierFlags(p) & MF.Readonly) ? 'const ' : '';
    const doc = buildDoc(p, this.ctx, {
      notes: ['@note Declared as a TypeScript constructor parameter property.'],
    });
    this.canvas.put(
      this.anchorOf(p),
      `${accessOf(p)}: ${konst}${type} ${name};`,
      doc.render(),
      { shared: true },
    );
    this.stats.fields++;
  }

  emitMethod(node, info, prefix) {
    const name = nameText(node.name) || 'method';
    const isStatic = hasFlag(node, MF.Static);
    // Only `abstract` members and interface members are pure virtual. A method
    // without a body is an overload signature or an ambient declaration.
    const isAbstract = info.isInterface || hasFlag(node, MF.Abstract);
    const ret = this.returnType(node);
    const params = this.paramList(node);
    const notes = [];
    const sig = this.signatureNote(node);
    if (sig) notes.push(sig);
    if (hasFlag(node, MF.Async)) notes.push('@note `async` function.');
    if (node.asteriskToken) notes.push('@note Generator function.');
    if (node.questionToken) notes.push('@note Optional member.');
    const doc = buildDoc(node, this.ctx, {
      notes,
      paramNames: this.lastParamNames,
      typeParamNames: this.typeParamNames(node),
      returnsVoid: ret === 'void',
    });

    const specifiers = [];
    if (isStatic) specifiers.push('static');
    else if (this.opts.virtualMethods !== false) specifiers.push('virtual');
    const template = this.templatePrefix(node);
    let body;
    if (isAbstract) body = { open: ' = 0;', close: null };
    else if (node.body) body = this.bodyFor(node, name);
    else body = { open: ';', close: null };

    this.canvas.put(
      this.anchorOf(node),
      `${prefix}${template}${specifiers.join(' ')}${specifiers.length ? ' ' : ''}${ret} ${name}(${params})${body.open}`,
      doc.render(),
    );
    if (!isAbstract && node.body) this.closeBody(node, body);
    this.stats.methods++;
  }

  emitProperty(node, info, prefix) {
    const name = nameText(node.name) || 'field';
    const initializer = node.initializer;
    // `handler = (x) => {...}` is a method in everything but syntax.
    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
      return this.emitFunctionLikeProperty(node, initializer, info, prefix);
    }
    const type = this.mapType(node.type, node);
    const specifiers = [];
    if (hasFlag(node, MF.Static)) specifiers.push('static');
    if (hasFlag(node, MF.Readonly)) specifiers.push('const');
    const notes = [];
    const sig = this.signatureNote(node);
    if (sig) notes.push(sig);
    if (node.questionToken) notes.push('@note Optional member.');
    if (hasFlag(node, MF.Abstract)) notes.push('@note `abstract` member.');
    const doc = buildDoc(node, this.ctx, { notes });
    const init = literalInitializer(initializer);
    this.canvas.put(
      this.anchorOf(node),
      `${prefix}${specifiers.join(' ')}${specifiers.length ? ' ' : ''}${type} ${name}${init ? ` = ${init}` : ''};`,
      doc.render(),
    );
    this.stats.fields++;
    return undefined;
  }

  emitFunctionLikeProperty(node, fn, info, prefix) {
    const name = nameText(node.name) || 'method';
    const ret = this.returnType(fn);
    const params = this.paramList(fn);
    const notes = ['@note Declared as a TypeScript property holding a function.'];
    const sig = this.signatureNote(node);
    if (sig) notes.push(sig);
    const doc = buildDoc(node, this.ctx, {
      notes,
      paramNames: this.lastParamNames,
      typeParamNames: this.typeParamNames(fn),
      returnsVoid: ret === 'void',
    });
    const specifiers = hasFlag(node, MF.Static) ? 'static ' : (this.opts.virtualMethods !== false ? 'virtual ' : '');
    const body = this.bodyFor(fn, name);
    this.canvas.put(
      this.anchorOf(node),
      `${prefix}${specifiers}${ret} ${name}(${params})${body.open}`,
      doc.render(),
    );
    this.closeBody(fn, body);
    this.stats.methods++;
    return undefined;
  }

  emitAccessor(node, info, prefix) {
    const name = nameText(node.name) || 'property';
    const isGetter = ts.isGetAccessor(node);
    const notes = [isGetter ? '@note TypeScript getter (`get`).' : '@note TypeScript setter (`set`).'];
    const sig = this.signatureNote(node);
    if (sig) notes.push(sig);
    const specifiersRet = isGetter ? this.returnType(node) : 'void';
    const doc = buildDoc(node, this.ctx, {
      notes,
      paramNames: this.lastParamNames,
      returnsVoid: specifiersRet === 'void',
    });
    const specifiers = hasFlag(node, MF.Static) ? 'static ' : (this.opts.virtualMethods !== false ? 'virtual ' : '');
    const ret = specifiersRet;
    const params = isGetter ? '' : this.paramList(node);
    const isAbstract = info.isInterface || hasFlag(node, MF.Abstract);
    let body;
    if (isAbstract) body = { open: ' = 0;', close: null };
    else if (node.body) body = this.bodyFor(node, name);
    else body = { open: ';', close: null };
    this.canvas.put(
      this.anchorOf(node),
      `${prefix}${specifiers}${ret} ${name}(${params})${body.open}`,
      doc.render(),
    );
    if (!isAbstract && node.body) this.closeBody(node, body);
    this.stats.methods++;
  }

  emitIndexSignature(node, info, prefix) {
    const ret = this.mapType(node.type, node);
    const params = this.paramList(node);
    const doc = buildDoc(node, this.ctx, {
      notes: [`@note TypeScript index signature ${escapeInlineCode(typeSourceText(node))}.`],
    });
    this.canvas.put(this.anchorOf(node), `${prefix}${ret} operator[](${params});`, doc.render());
    this.stats.methods++;
  }

  emitCallSignature(node, info, prefix) {
    const ret = this.returnType(node);
    const params = this.paramList(node);
    const doc = buildDoc(node, this.ctx, {
      notes: ['@note TypeScript call signature: the type itself is callable.'],
      paramNames: this.lastParamNames,
      returnsVoid: ret === 'void',
    });
    this.canvas.put(this.anchorOf(node), `${prefix}${ret} operator()(${params});`, doc.render());
    this.stats.methods++;
  }

  emitConstructSignature(node, info, prefix) {
    const params = this.paramList(node);
    const doc = buildDoc(node, this.ctx, {
      notes: [`@note TypeScript construct signature ${escapeInlineCode(typeSourceText(node))}.`],
    });
    this.canvas.put(this.anchorOf(node), `${prefix}${info.name}(${params});`, doc.render());
    this.stats.methods++;
  }

  /* ------------------------------------------------------------------ *
   * enums, type aliases, functions, variables, namespaces
   * ------------------------------------------------------------------ */

  emitEnum(node) {
    const name = nameText(node.name);
    const notes = [];
    if (hasFlag(node, MF.Const)) notes.push('@note TypeScript `const enum`.');
    const exported = this.exportNote(node, name);
    if (exported) notes.push(exported);
    const doc = buildDoc(node, this.ctx, { notes });
    this.canvas.put(this.anchorOf(node), `enum class ${name} {`, doc.render());
    for (const member of node.members) {
      const mname = nameText(member.name) || 'VALUE';
      const value = literalInitializer(member.initializer);
      const mdoc = buildDoc(member, this.ctx, {});
      this.canvas.put(this.anchorOf(member), `${mname}${value ? ` = ${value}` : ''},`, mdoc.render());
    }
    this.canvas.put(this.endLineOf(node), '};', null, { shared: true });
    this.stats.enums++;
  }

  emitTypeAlias(node) {
    const name = nameText(node.name);
    this.lossy = false;
    const target = this.mapType(node.type, node);
    const notes = [`@note TypeScript type alias: ${escapeInlineCode(typeSourceText(node))}`];
    const exported = this.exportNote(node, name);
    if (exported) notes.push(exported);
    for (const extra of this.typeParameterNotes(node)) notes.push(extra);
    const doc = buildDoc(node, this.ctx, {
      notes,
      typeParamNames: this.typeParamNames(node),
    });
    const template = this.templatePrefix(node);
    const code = template
      ? `${template}using ${name} = ${target};`
      : `typedef ${target} ${name};`;
    this.canvas.put(this.anchorOf(node), code, doc.render());
    this.stats.typedefs++;
  }

  emitFunction(node, nameOverride) {
    const name = nameOverride || (node.name ? nameText(node.name) : this.anonymousName(node));
    this.lossy = false;
    const ret = this.returnType(node);
    const params = this.paramList(node);
    const notes = [];
    const sig = this.signatureNote(node);
    if (sig) notes.push(sig);
    if (hasFlag(node, MF.Async)) notes.push('@note `async` function.');
    if (node.asteriskToken) notes.push('@note Generator function.');
    const exported = this.exportNote(node, name);
    if (exported) notes.push(exported);
    for (const extra of this.typeParameterNotes(node)) notes.push(extra);
    const doc = buildDoc(node, this.ctx, {
      notes,
      paramNames: this.lastParamNames,
      typeParamNames: this.typeParamNames(node),
      returnsVoid: ret === 'void',
    });
    const template = this.templatePrefix(node);
    const hasBody = !!node.body;
    const body = hasBody ? this.bodyFor(node, name) : { open: ';', close: null };
    this.canvas.put(
      this.anchorOf(node),
      `${template}${ret} ${name}(${params})${body.open}`,
      doc.render(),
    );
    if (hasBody) this.closeBody(node, body);
    this.stats.functions++;
  }

  emitVariableStatement(st) {
    const isConst = !!(st.declarationList.flags & ts.NodeFlags.Const);
    for (const decl of st.declarationList.declarations) {
      if (!decl.name || !ts.isIdentifier(decl.name)) continue; // destructuring
      const name = nameText(decl.name);
      const init = decl.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        this.emitArrowFunction(decl, init, name);
        continue;
      }
      if (init && ts.isClassExpression(init)) {
        this.emitClassLike(init, 'class', name);
        continue;
      }
      this.lossy = false;
      const type = this.mapType(decl.type, decl);
      const notes = [];
      const sig = this.signatureNote(decl);
      if (sig) notes.push(sig);
      const exported = this.exportNote(decl, name);
      if (exported) notes.push(exported);
      const doc = buildDoc(decl.jsDoc ? decl : st, this.ctx, { notes });
      const value = literalInitializer(init);
      this.canvas.put(
        this.anchorOf(decl),
        `${isConst ? 'const ' : ''}${type} ${name}${value ? ` = ${value}` : ''};`,
        doc.render(),
      );
      this.stats.variables++;
    }
  }

  emitArrowFunction(decl, fn, name) {
    this.lossy = false;
    const ret = this.returnType(fn);
    const params = this.paramList(fn);
    const notes = ['@note Declared as a TypeScript arrow function / function expression.'];
    const sig = this.signatureNote(decl);
    if (sig) notes.push(sig);
    if (hasFlag(fn, MF.Async)) notes.push('@note `async` function.');
    const exported = this.exportNote(decl, name);
    if (exported) notes.push(exported);
    const doc = buildDoc(decl.jsDoc ? decl : decl.parent.parent, this.ctx, {
      notes,
      paramNames: this.lastParamNames,
      typeParamNames: this.typeParamNames(fn),
      returnsVoid: ret === 'void',
    });
    const template = this.templatePrefix(fn);
    const body = this.bodyFor(fn, name);
    this.canvas.put(
      this.anchorOf(decl),
      `${template}${ret} ${name}(${params})${body.open}`,
      doc.render(),
    );
    this.closeBody(fn, body);
    this.stats.functions++;
  }

  emitModule(node) {
    const name = nameText(node.name) || 'module_';
    const doc = buildDoc(node, this.ctx, {
      notes: [ts.isStringLiteral(node.name)
        ? `@note TypeScript ambient module declaration ${escapeInlineCode(node.name.text)}.`
        : '@note TypeScript `namespace` declaration.'],
    });
    this.canvas.put(this.anchorOf(node), `namespace ${name} {`, doc.render());
    if (node.body && ts.isModuleBlock(node.body)) {
      this.emitStatements(node.body.statements);
    } else if (node.body && ts.isModuleDeclaration(node.body)) {
      this.emitModule(node.body);
    }
    this.canvas.put(this.endLineOf(node), '}', null, { shared: true });
    this.stats.namespaces++;
  }

  /* ------------------------------------------------------------------ *
   * shared pieces
   * ------------------------------------------------------------------ */

  /** Phase 3 fills function bodies with the calls they make. */
  bodyFor() {
    return { open: ';', close: null };
  }

  closeBody() {}

  anonymousName(node) {
    const base = require('path').basename(this.sf.fileName).replace(/\..*$/, '');
    return sanitizeIdentifier(`${base}_default`, 'anonymous');
  }

  /** `template< typename T, typename U = string >` or '' when not generic. */
  templatePrefix(node) {
    const tps = node.typeParameters;
    if (!tps || !tps.length) return '';
    const parts = tps.map((tp) => {
      const name = sanitizeIdentifier(tp.name.text, 'T');
      const dflt = tp.default ? ` = ${mapTypeNode(tp.default, this.ctx)}` : '';
      return `typename ${name}${dflt}`;
    });
    return `template< ${parts.join(', ')} > `;
  }

  /** Names of the emitted template parameters, for `@tparam` matching. */
  typeParamNames(node) {
    const names = new Set();
    for (const tp of node.typeParameters || []) {
      names.add(sanitizeIdentifier(tp.name.text, 'T'));
    }
    return names;
  }

  /** Generic constraints cannot be expressed, so they go into the docs. */
  typeParameterNotes(node) {
    const tps = node.typeParameters;
    if (!tps || !tps.length) return [];
    const constrained = tps.filter((tp) => tp.constraint || tp.default);
    if (!constrained.length) return [];
    const parts = constrained.map((tp) => escapeInlineCode(typeSourceText(tp)));
    return [`@note TypeScript type parameters: ${parts.join(', ')}.`];
  }

  /** Map a type node, tracking whether information was lost on the way. */
  mapType(typeNode, fallbackNode) {
    if (!typeNode) {
      this.lossy = true;
      return fallbackNode ? mapInferredType(fallbackNode, this.ctx, 'auto') : 'auto';
    }
    const mapped = mapTypeNode(typeNode, this.ctx);
    if (!isFaithful(mapped, typeSourceText(typeNode))) this.lossy = true;
    return mapped;
  }

  returnType(node) {
    if (node.type) return this.mapType(node.type, node);
    try {
      const signature = this.ctx.checker.getSignatureFromDeclaration(node);
      if (signature) {
        const returnType = this.ctx.checker.getReturnTypeOfSignature(signature);
        this.lossy = true;
        return mapCheckerType(returnType, node, this.ctx, 'auto');
      }
    } catch { /* fall through */ }
    this.lossy = true;
    return 'auto';
  }

  /**
   * Render a parameter list, and record the names it used.
   *
   * `@param` may only be emitted for a name that really appears in the
   * signature, so `lastParamNames` is what the documentation builder checks
   * against. Every call site computes the parameter list before building the
   * documentation.
   */
  paramList(node) {
    const params = (node.parameters || []).filter(
      (p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'),
    );
    const parts = [];
    const names = new Set();
    this.lastParamNames = names;
    params.forEach((p, index) => {
      let type = p.type ? this.mapType(p.type, p) : mapInferredType(p, this.ctx, 'any');
      if (!p.type) this.lossy = true;
      if (p.dotDotDotToken && !/^Array</.test(type)) type = `Array< ${type} >`;
      const name = ts.isIdentifier(p.name)
        ? nameText(p.name)
        : `arg${index}`;
      const dflt = p.initializer
        ? literalInitializer(p.initializer)
        : (p.questionToken ? 'undefined' : null);
      names.add(name);
      parts.push(`${type} ${name}${dflt ? ` = ${dflt}` : ''}`);
    });
    return parts.join(', ');
  }

  /**
   * One-line note carrying the original TypeScript declaration, emitted only
   * when the mapping above had to simplify something.
   */
  signatureNote(node) {
    if (!this.lossy) return null;
    this.lossy = false;
    const text = declarationSourceText(node);
    if (!text) return null;
    return `@note TypeScript declaration: ${escapeInlineCode(text)}`;
  }

  exportNote(node, name) {
    const flags = ts.getCombinedModifierFlags(node);
    if (flags & MF.Default) return '@note Default export of this module.';
    if (flags & MF.Export) return `@note Exported as named export ${escapeInlineCode(name)}.`;
    const local = node.name && node.name.text;
    const entry = local && this.exports.get(local);
    if (entry) {
      return entry.isDefault
        ? '@note Default export of this module.'
        : `@note Exported as named export ${escapeInlineCode(entry.exportedAs)}.`;
    }
    return null;
  }
}

/* -------------------------------------------------------------------- *
 * helpers
 * -------------------------------------------------------------------- */

/**
 * The implementation signatures of overload sets among `nodes`.
 *
 * TypeScript writes overloads as several body-less signatures followed by one
 * implementation whose parameter types are the union of all of them. Only the
 * signatures are callable, so only they are documented.
 */
function overloadImplementations(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const isCandidate = ts.isConstructorDeclaration(node)
      || ts.isMethodDeclaration(node)
      || ts.isFunctionDeclaration(node);
    if (!isCandidate) continue;
    const key = ts.isConstructorDeclaration(node)
      ? 'constructor'
      : `${node.kind}:${node.name ? nameText(node.name) : ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const implementations = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const withBody = group.filter((n) => n.body);
    if (withBody.length === 1 && group.length > withBody.length) {
      implementations.add(withBody[0]);
    }
  }
  return implementations;
}

function hasFlag(node, flag) {
  return (ts.getCombinedModifierFlags(node) & flag) !== 0;
}

function accessOf(node) {
  if (node.name && ts.isPrivateIdentifier(node.name)) return 'private';
  const flags = ts.getCombinedModifierFlags(node);
  if (flags & MF.Private) return 'private';
  if (flags & MF.Protected) return 'protected';
  return 'public';
}

/**
 * `export { Foo as Bar }` / `export default Foo` statements, mapped from the
 * local name so that declarations elsewhere in the file can be marked.
 */
function collectExports(sourceFile) {
  const map = new Map();
  for (const st of sourceFile.statements) {
    if (ts.isExportAssignment(st)) {
      if (ts.isIdentifier(st.expression)) {
        map.set(st.expression.text, { isDefault: !st.isExportEquals, exportedAs: 'default' });
      }
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier
               && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const element of st.exportClause.elements) {
        const local = (element.propertyName || element.name).text;
        map.set(local, {
          isDefault: element.name.text === 'default',
          exportedAs: element.name.text,
        });
      }
    }
  }
  return map;
}

/** Source text of a declaration without its JSDoc and without its body. */
function declarationSourceText(node) {
  if (!node || !node.getText) return '';
  let text;
  try {
    text = node.getText();
  } catch {
    return '';
  }
  if (node.body && node.body.getText) {
    const bodyText = node.body.getText();
    const at = text.lastIndexOf(bodyText);
    if (at > 0) text = text.slice(0, at);
  }
  text = text.replace(/\s+/g, ' ').trim().replace(/[;,{]+$/, '').trim();
  if (text.length > 160) text = `${text.slice(0, 157)}...`;
  return text;
}

/**
 * Initializer rendered as a C++ default value, or null when it is not a simple
 * token. Commas, parentheses and braces are rejected: Doxygen splits parameter
 * lists on commas, so an expression default would corrupt the signature.
 */
function literalInitializer(node) {
  if (!node) return null;
  let text;
  try {
    text = node.getText().replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
  if (!text || text.length > 40) return null;
  // A quoted string is safe even when it contains a comma or a brace.
  if (ts.isStringLiteralLike(node)) {
    return JSON.stringify(node.text).replace(/[^\x20-\x7e]/g, '?');
  }
  if (/[,(){}[\]<>;]/.test(text)) return null;
  if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return text;
  switch (node.kind) {
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return text;
    default:
      break;
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    return text.replace(/\./g, '::');
  }
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return text;
  return null;
}

/** Did the type mapping preserve the original meaning? */
function isFaithful(mapped, source) {
  if (!source) return false;
  const a = mapped.replace(/\s+/g, '');
  const b = source.replace(/\s+/g, '');
  if (a === b) return true;
  const arr = /^(.*)\[\]$/.exec(b);
  if (arr) return isFaithful(a.replace(/^Array</, '').replace(/>$/, ''), arr[1]);
  return false;
}

module.exports = {
  Translator,
  collectExports,
  declarationSourceText,
  isFaithful,
  literalInitializer,
  overloadImplementations,
};
