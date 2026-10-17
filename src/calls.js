'use strict';
/**
 * Call extraction -- the part that gives Doxygen its call and caller graphs.
 *
 * Doxygen builds those graphs by parsing function *bodies*, so every function
 * we emit gets a body containing nothing but the calls it makes, each written
 * as a fully qualified call statement (`ns::Class::method();`) on the line the
 * original call occupies. Targets are resolved with the type checker, which is
 * what makes the edges cross file boundaries.
 *
 * A call is put in one of five buckets:
 *
 *   - `resolved`   -- target is a declaration we translate: emitted.
 *   - `external`   -- target is in `lib.d.ts` or `node_modules`: omitted,
 *                     since Doxygen has no node for it (`console.log`, ...).
 *   - `indirect`   -- target resolved, but to something that is not a
 *                     documented entity: a function nested inside another
 *                     body, or a parameter or local variable holding a
 *                     callback. Omitted, because the name would have nothing
 *                     to bind to on Doxygen's side.
 *   - `unresolved` -- no declaration found at all: untyped JavaScript,
 *                     `obj[name]()`, a callback the checker cannot follow.
 *   - `recursive`  -- counted as resolved; kept as its own number because a
 *                     self-call says nothing about resolution quality.
 */

const ts = require('typescript');
const {
  isProjectFile, nameText, primaryDeclaration, qualifiedNameOfDeclaration, resolveAlias,
} = require('./symbols');

/** Containers a declaration may sit in and still be emitted by the translator. */
function isEmittableContainer(node) {
  return ts.isSourceFile(node)
    || ts.isModuleDeclaration(node)
    || ts.isModuleBlock(node)
    || ts.isClassLike(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isEnumDeclaration(node)
    || ts.isTypeLiteralNode(node)
    || ts.isVariableDeclaration(node)
    || ts.isVariableDeclarationList(node)
    || ts.isVariableStatement(node)
    || ts.isPropertyDeclaration(node)
    || ts.isPropertySignature(node)
    || ts.isPropertyAssignment(node)
    || ts.isConstructorDeclaration(node);
}

/**
 * Does the translator emit a declaration for this node?
 *
 * Only declarations at file scope, inside a TypeScript namespace, or as a
 * member of a class or interface are emitted. A function declared inside
 * another function body is not, and neither is a parameter holding a
 * callback, so a call to either must not be written out -- the name would
 * have nothing to bind to in Doxygen's model.
 */
function isEmittedDeclaration(decl) {
  if (ts.isParameter(decl) || ts.isBindingElement(decl)) return false;
  let node = decl.parent;
  while (node && !ts.isSourceFile(node)) {
    if (!isEmittableContainer(node)) return false;
    node = node.parent;
  }
  return !!node;
}

/** The expression naming the callee. */
function calleeExpression(node) {
  if (ts.isTaggedTemplateExpression(node)) return node.tag;
  return node.expression;
}

/** Declaration a call resolves to, through the checker and then by symbol. */
function resolveDeclaration(node, ctx) {
  try {
    const signature = ctx.checker.getResolvedSignature(node);
    if (signature && signature.declaration) return signature.declaration;
  } catch { /* fall through to the symbol lookup */ }

  const callee = calleeExpression(node);
  if (!callee) return null;
  try {
    let symbol = ctx.checker.getSymbolAtLocation(callee);
    if (!symbol && (ts.isPropertyAccessExpression(callee) || ts.isQualifiedName(callee))) {
      symbol = ctx.checker.getSymbolAtLocation(callee.name);
    }
    if (!symbol) return null;
    return primaryDeclaration(resolveAlias(symbol, ctx.checker));
  } catch {
    return null;
  }
}

/**
 * Qualified name to call for a declaration.
 *
 * `new X()` and `super()` have to end up at `ns::X::X` -- the constructor --
 * even when the class declares none, because the translator synthesizes one
 * for exactly this reason.
 */
function callNameFor(decl, isConstruction, ctx) {
  const qualified = qualifiedNameOfDeclaration(decl, ctx);
  if (!qualified) return null;
  if (isConstruction && (ts.isClassLike(decl) || ts.isInterfaceDeclaration(decl))) {
    // The checker gave us the class rather than a constructor declaration.
    const name = decl.name ? nameText(decl.name) : qualified[qualified.length - 1];
    return [...qualified, name].join('::');
  }
  return qualified.join('::');
}

/** A call-like node? */
function isCallLike(node) {
  return ts.isCallExpression(node)
    || ts.isNewExpression(node)
    || ts.isTaggedTemplateExpression(node);
}

/** Short source text of a call, for the unresolved-call samples. */
function callText(node) {
  try {
    const text = calleeExpression(node).getText().replace(/\s+/g, ' ').trim();
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  } catch {
    return '<call>';
  }
}

/**
 * Extract the calls made by a function-like declaration.
 *
 * Nested arrow functions and function expressions are walked as part of the
 * enclosing function: `items.forEach((x) => handle(x))` really does reach
 * `handle`, and Doxygen's model has nowhere else to put that edge. Parameter
 * initializers are included for the same reason -- they run on every call.
 *
 * @returns `{calls, stats}` where `calls` is `[{line, name}]` in source order.
 */
function extractCalls(fn, ctx, options = {}) {
  const sourceFile = fn.getSourceFile();
  const selfName = ctx.currentFunctionName || null;
  const calls = [];
  const seen = new Set();
  const stats = {
    total: 0, resolved: 0, external: 0, indirect: 0, unresolved: 0, recursive: 0,
  };
  const unresolved = [];

  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(
    Math.max(0, Math.min(pos, sourceFile.end)),
  ).line + 1;

  const record = (node) => {
    stats.total++;
    const isConstruction = ts.isNewExpression(node)
      || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword);
    const decl = resolveDeclaration(node, ctx);
    if (!decl) {
      stats.unresolved++;
      unresolved.push({ line: lineOf(node.getStart(sourceFile)), text: callText(node) });
      return;
    }
    if (!isProjectFile(decl.getSourceFile(), ctx)) {
      stats.external++;
      return;
    }
    if (!isEmittedDeclaration(decl)) {
      stats.indirect++;
      return;
    }
    const name = callNameFor(decl, isConstruction, ctx);
    if (!name) {
      stats.unresolved++;
      unresolved.push({ line: lineOf(node.getStart(sourceFile)), text: callText(node) });
      return;
    }
    stats.resolved++;
    if (selfName && name === selfName) stats.recursive++;
    const line = lineOf(node.getStart(sourceFile));
    const key = `${line}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ line, name });
  };

  const visit = (node) => {
    if (isCallLike(node)) record(node);
    ts.forEachChild(node, visit);
  };

  for (const parameter of fn.parameters || []) {
    if (parameter.initializer) visit(parameter.initializer);
  }
  if (fn.body) visit(fn.body);

  calls.sort((a, b) => a.line - b.line);
  if (options.listUnresolved) stats.unresolvedCalls = unresolved;
  return { calls, stats, unresolved };
}

module.exports = {
  callNameFor,
  extractCalls,
  isEmittedDeclaration,
  resolveDeclaration,
};
