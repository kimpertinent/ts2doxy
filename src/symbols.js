'use strict';
/**
 * Mapping TypeScript declarations onto fully qualified C++ names.
 *
 * This is the glue that makes cross-file features work: inheritance edges and
 * call-graph edges are only drawn by Doxygen if the name written in one file's
 * pseudo-code is character-for-character the name declared in another file's
 * pseudo-code. Both sides go through `qualifiedNameOfDeclaration`.
 */

const ts = require('typescript');
const { namespaceSegmentsForFile, qualify, sanitizeIdentifier } = require('./names');

/** True for files we translate ourselves (i.e. whose pseudo-code Doxygen sees). */
function isProjectFile(sourceFile, ctx) {
  if (!sourceFile) return false;
  const f = sourceFile.fileName;
  if (/[\\/]node_modules[\\/]/.test(f)) return false;
  if (sourceFile.hasNoDefaultLib) return false;
  if (ctx && ctx.program && ctx.program.isSourceFileDefaultLibrary &&
      ctx.program.isSourceFileDefaultLibrary(sourceFile)) {
    return false;
  }
  return true;
}

/** Text of a declaration name node, sanitized into a C++ identifier. */
function nameText(nameNode) {
  if (!nameNode) return null;
  if (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode)) {
    return sanitizeIdentifier(nameNode.text.replace(/^#/, ''));
  }
  if (ts.isStringLiteralLike(nameNode) || ts.isNumericLiteral(nameNode)) {
    return sanitizeIdentifier(nameNode.text, 'member');
  }
  if (ts.isComputedPropertyName(nameNode)) {
    return sanitizeIdentifier(nameNode.expression.getText(), 'computed');
  }
  return sanitizeIdentifier(nameNode.getText ? nameNode.getText() : String(nameNode), 'member');
}

/** The containers that become a `namespace` or a `class` in the output. */
function containerNameOf(node) {
  if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
    return node.name ? nameText(node.name) : null;
  }
  if (ts.isModuleDeclaration(node)) {
    return nameText(node.name);
  }
  return undefined; // not a container
}

/**
 * Qualified name of a declaration, as an array of C++ name parts.
 * Returns null when the declaration lives outside the translated sources
 * (lib.d.ts, node_modules) or cannot be addressed.
 */
function qualifiedNameOfDeclaration(decl, ctx) {
  if (!decl) return null;
  const sf = decl.getSourceFile && decl.getSourceFile();
  if (!isProjectFile(sf, ctx)) return null;

  let leaf = null;
  if (ts.isConstructorDeclaration(decl)) {
    const cls = decl.parent;
    const clsName = cls && cls.name ? nameText(cls.name) : null;
    leaf = clsName; // ns::Class::Class()
  } else if (decl.name) {
    leaf = nameText(decl.name);
  } else if (ts.isVariableDeclaration(decl.parent || {}) && decl.parent.name) {
    leaf = nameText(decl.parent.name);
  } else if (ts.isPropertyAssignment(decl.parent || {})) {
    leaf = nameText(decl.parent.name);
  }
  if (!leaf) return null;

  const parts = [];
  // A constructor is named after its class, which therefore has to appear
  // twice: `ns::Foo::Foo`. Walking from the class itself (not from its
  // parent) is what puts it there.
  let node = decl.parent;
  while (node && !ts.isSourceFile(node)) {
    const name = containerNameOf(node);
    if (name) parts.unshift(name);
    node = node.parent;
  }
  const ns = namespaceSegmentsForFile(
    sf.fileName, ctx.rootDir, ctx.namespaceMode, ctx.namespaceName,
  );
  return [...ns, ...parts, leaf];
}

/** Follow import/export aliases to the declaration that actually defines a symbol. */
function resolveAlias(symbol, checker) {
  if (!symbol) return symbol;
  let s = symbol;
  const seen = new Set();
  while (s && (s.flags & ts.SymbolFlags.Alias) && !seen.has(s)) {
    seen.add(s);
    const next = checker.getAliasedSymbol(s);
    if (!next || next === s) break;
    s = next;
  }
  return s;
}

/** Pick the declaration of a symbol that is most useful for naming. */
function primaryDeclaration(symbol) {
  if (!symbol || !symbol.declarations || !symbol.declarations.length) return null;
  const decls = symbol.declarations;
  // Prefer a real implementation over an overload signature or a .d.ts stub.
  const withBody = decls.find((d) => d.body);
  if (withBody) return withBody;
  const notAmbient = decls.find((d) => !d.getSourceFile().isDeclarationFile);
  return notAmbient || decls[0];
}

/** Qualified name for a symbol (after alias resolution). */
function qualifiedNameOfSymbol(symbol, ctx) {
  const resolved = resolveAlias(symbol, ctx.checker);
  const decl = primaryDeclaration(resolved);
  if (!decl) return null;
  return qualifiedNameOfDeclaration(decl, ctx);
}

module.exports = {
  containerNameOf,
  isProjectFile,
  nameText,
  primaryDeclaration,
  qualifiedNameOfDeclaration,
  qualifiedNameOfSymbol,
  qualify,
  resolveAlias,
};
