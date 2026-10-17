'use strict';
/**
 * TypeScript type -> Doxygen-parseable type expression.
 *
 * Doxygen's C++ parser must never choke on what we emit, so every type is
 * rendered either as an identifier, a template instantiation
 * (`Array<ns::Foo>`) or a `std::function<...>`. Anything that has no such
 * form -- unions, intersections, conditional, mapped and literal types -- is
 * reduced to a sanitized identifier, and the original TypeScript text is
 * carried into the documentation block instead (see jsdoc.js).
 *
 * Primitive names are kept as they are written in TypeScript (`number`,
 * `string`, `boolean`): they are legal C++ identifiers, and pretending that
 * `number` is a `double` would only mislead the reader.
 */

const ts = require('typescript');
const { sanitizeIdentifier } = require('./names');
const { isProjectFile, qualifiedNameOfSymbol, resolveAlias } = require('./symbols');

const MAX_SYNTHETIC_NAME = 48;

const KEYWORD_TYPES = new Map([
  [ts.SyntaxKind.AnyKeyword, 'any'],
  [ts.SyntaxKind.UnknownKeyword, 'unknown'],
  [ts.SyntaxKind.NumberKeyword, 'number'],
  [ts.SyntaxKind.BigIntKeyword, 'bigint'],
  [ts.SyntaxKind.ObjectKeyword, 'object'],
  [ts.SyntaxKind.BooleanKeyword, 'boolean'],
  [ts.SyntaxKind.StringKeyword, 'string'],
  [ts.SyntaxKind.SymbolKeyword, 'symbol'],
  [ts.SyntaxKind.VoidKeyword, 'void'],
  [ts.SyntaxKind.UndefinedKeyword, 'undefined'],
  [ts.SyntaxKind.NeverKeyword, 'never'],
  [ts.SyntaxKind.IntrinsicKeyword, 'intrinsic'],
]);

/** Normalized one-line rendering of the TypeScript source text of a type. */
function typeSourceText(node) {
  if (!node || !node.getText) return '';
  try {
    return node.getText().replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

/** The trailing component of a qualified name, used to build synthetic names. */
function lastSegment(name) {
  const i = name.lastIndexOf('::');
  return i === -1 ? name : name.slice(i + 2);
}

function isSimpleIdentifier(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Join constituent type names into one identifier, e.g. `string_or_number`. */
function combineNames(parts, joiner, fallback) {
  const simple = parts.map(lastSegment).filter(isSimpleIdentifier);
  if (simple.length !== parts.length || !simple.length) return fallback;
  const unique = [...new Set(simple)];
  const combined = unique.join(joiner);
  if (combined.length > MAX_SYNTHETIC_NAME) return fallback;
  return sanitizeIdentifier(combined, fallback);
}

/** Resolve a `Foo` / `ns.Foo` type reference to its qualified emitted name. */
function mapTypeReferenceName(typeName, ctx) {
  const plain = sanitizeIdentifier(
    ts.isIdentifier(typeName) ? typeName.text : typeName.getText().split('.').pop(),
    'Type',
  );
  let symbol = ctx.checker.getSymbolAtLocation(typeName);
  if (!symbol) return plain;
  if (symbol.flags & ts.SymbolFlags.TypeParameter) {
    return sanitizeIdentifier(symbol.name, 'T');
  }
  symbol = resolveAlias(symbol, ctx.checker);
  const decls = symbol.declarations || [];
  const local = decls.some((d) => isProjectFile(d.getSourceFile(), ctx));
  if (!local) return plain; // lib / node_modules type: keep the bare name
  const qualified = qualifiedNameOfSymbol(symbol, ctx);
  return qualified ? qualified.join('::') : plain;
}

/**
 * Map a type node to a C++ type expression.
 * @returns {string}
 */
function mapTypeNode(node, ctx) {
  if (!node) return 'auto';
  const kw = KEYWORD_TYPES.get(node.kind);
  if (kw) return kw;

  switch (node.kind) {
    case ts.SyntaxKind.ParenthesizedType:
      return mapTypeNode(node.type, ctx);

    case ts.SyntaxKind.ThisType:
      return ctx.currentTypeName || 'This';

    case ts.SyntaxKind.LiteralType: {
      const lit = node.literal;
      if (lit.kind === ts.SyntaxKind.NullKeyword) return 'null';
      if (lit.kind === ts.SyntaxKind.TrueKeyword || lit.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
      if (ts.isStringLiteralLike(lit)) return 'string';
      if (ts.isNumericLiteral(lit)) return 'number';
      if (ts.isBigIntLiteral(lit)) return 'bigint';
      if (ts.isPrefixUnaryExpression(lit)) return 'number';
      return 'literal';
    }

    case ts.SyntaxKind.TypeReference: {
      const base = mapTypeReferenceName(node.typeName, ctx);
      if (node.typeArguments && node.typeArguments.length) {
        const args = node.typeArguments.map((a) => mapTypeNode(a, ctx));
        return `${base}< ${args.join(', ')} >`;
      }
      return base;
    }

    case ts.SyntaxKind.ExpressionWithTypeArguments: {
      const base = ts.isIdentifier(node.expression) || ts.isPropertyAccessExpression(node.expression)
        ? mapHeritageName(node, ctx)
        : 'object';
      return base;
    }

    case ts.SyntaxKind.ArrayType:
      return `Array< ${mapTypeNode(node.elementType, ctx)} >`;

    case ts.SyntaxKind.TupleType: {
      const parts = node.elements.map((e) => mapTypeNode(
        ts.isNamedTupleMember(e) ? e.type : (e.type || e), ctx,
      ));
      return `Tuple< ${parts.join(', ')} >`;
    }

    case ts.SyntaxKind.OptionalType:
    case ts.SyntaxKind.RestType:
      return mapTypeNode(node.type, ctx);

    case ts.SyntaxKind.UnionType: {
      // `T | undefined` / `T | null` are rendered as `T`: the nullability is
      // visible in the documented TypeScript type, and keeping `T` lets
      // Doxygen link the member to its actual class.
      const kept = node.types.filter((t) => !isNullishTypeNode(t));
      const effective = kept.length ? kept : node.types;
      const parts = effective.map((t) => mapTypeNode(t, ctx));
      const unique = [...new Set(parts)];
      if (unique.length === 1) return unique[0];
      return combineNames(unique, '_or_', 'Union');
    }

    case ts.SyntaxKind.IntersectionType: {
      const parts = node.types.map((t) => mapTypeNode(t, ctx));
      const unique = [...new Set(parts)];
      if (unique.length === 1) return unique[0];
      return combineNames(unique, '_and_', 'Intersection');
    }

    case ts.SyntaxKind.FunctionType:
    case ts.SyntaxKind.ConstructorType: {
      const ret = mapTypeNode(node.type, ctx);
      const params = (node.parameters || []).map((p) => mapTypeNode(
        p.type, ctx,
      ));
      return `std::function< ${ret}(${params.join(', ')}) >`;
    }

    case ts.SyntaxKind.TypeLiteral:
      return 'object';

    case ts.SyntaxKind.MappedType:
      return 'MappedType';

    case ts.SyntaxKind.ConditionalType:
      return 'ConditionalType';

    case ts.SyntaxKind.InferType:
      return sanitizeIdentifier(node.typeParameter.name.text, 'Inferred');

    case ts.SyntaxKind.TemplateLiteralType:
      return 'string';

    case ts.SyntaxKind.TypePredicate:
      return 'boolean';

    case ts.SyntaxKind.TypeOperator: {
      if (node.operator === ts.SyntaxKind.KeyOfKeyword) {
        const inner = mapTypeNode(node.type, ctx);
        return combineNames([`keyof_${lastSegment(inner)}`], '_', 'keyof_type');
      }
      // `readonly T[]` and `unique symbol`
      return mapTypeNode(node.type, ctx);
    }

    case ts.SyntaxKind.TypeQuery: {
      const text = node.exprName ? node.exprName.getText().split('.').pop() : 'value';
      return sanitizeIdentifier(`typeof_${text}`, 'typeof_value');
    }

    case ts.SyntaxKind.IndexedAccessType: {
      const obj = lastSegment(mapTypeNode(node.objectType, ctx));
      return sanitizeIdentifier(`${obj}_element`, 'IndexedAccess');
    }

    case ts.SyntaxKind.ImportType: {
      if (node.qualifier) {
        const sym = ctx.checker.getSymbolAtLocation(node.qualifier);
        if (sym) {
          const q = qualifiedNameOfSymbol(sym, ctx);
          if (q) return q.join('::');
        }
        return sanitizeIdentifier(node.qualifier.getText().split('.').pop(), 'Imported');
      }
      return 'object';
    }

    default:
      return sanitizeIdentifier(typeSourceText(node).split(/[^A-Za-z0-9_]/)[0] || 'any', 'any');
  }
}

function isNullishTypeNode(node) {
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  if (node.kind === ts.SyntaxKind.NullKeyword) return true;
  if (node.kind === ts.SyntaxKind.LiteralType &&
      node.literal.kind === ts.SyntaxKind.NullKeyword) return true;
  return false;
}

/**
 * Qualified name of an `extends` / `implements` clause entry. Base classes have
 * to be fully qualified or Doxygen will not connect the two classes.
 */
function mapHeritageName(exprWithTypeArgs, ctx) {
  const expr = exprWithTypeArgs.expression;
  let symbol = ctx.checker.getSymbolAtLocation(expr);
  if (!symbol && ts.isPropertyAccessExpression(expr)) {
    symbol = ctx.checker.getSymbolAtLocation(expr.name);
  }
  let name = null;
  if (symbol) {
    symbol = resolveAlias(symbol, ctx.checker);
    const decls = symbol.declarations || [];
    if (decls.some((d) => isProjectFile(d.getSourceFile(), ctx))) {
      const q = qualifiedNameOfSymbol(symbol, ctx);
      if (q) name = q.join('::');
    }
  }
  if (!name) {
    const text = typeSourceText(expr).split('.').pop();
    name = sanitizeIdentifier(text, 'Base');
  }
  if (exprWithTypeArgs.typeArguments && exprWithTypeArgs.typeArguments.length) {
    const args = exprWithTypeArgs.typeArguments.map((a) => mapTypeNode(a, ctx));
    return `${name}< ${args.join(', ')} >`;
  }
  return name;
}

/**
 * If a checker-derived type names a class, interface, enum or alias that we
 * translate ourselves, use its qualified name -- otherwise cross-file links
 * (and therefore the collaboration graph) would silently break.
 */
function qualifyTypeSymbol(type, ctx) {
  const symbol = type && type.getSymbol && type.getSymbol();
  if (!symbol) return null;
  const interesting = ts.SymbolFlags.Class | ts.SymbolFlags.Interface
    | ts.SymbolFlags.Enum | ts.SymbolFlags.TypeAlias;
  if (!(symbol.flags & interesting)) return null;
  const decls = symbol.declarations || [];
  if (!decls.some((d) => isProjectFile(d.getSourceFile(), ctx))) return null;
  const qualified = qualifiedNameOfSymbol(symbol, ctx);
  return qualified ? qualified.join('::') : null;
}

/** Map a `ts.Type` obtained from the checker onto an emittable type name. */
function mapCheckerType(type, node, ctx, fallback = 'auto') {
  if (!type) return fallback;
  const qualified = qualifyTypeSymbol(type, ctx);
  if (qualified) return qualified;
  const printed = ctx.checker.typeToString(
    type,
    node,
    ts.TypeFormatFlags.NoTruncation,
  );
  return sanitizeTypeText(printed, fallback);
}

/**
 * Type of a declaration that has no explicit type annotation (very common in
 * JavaScript and for inferred return types). Falls back to the checker and
 * sanitizes whatever it prints.
 */
function mapInferredType(node, ctx, fallback = 'auto') {
  try {
    return mapCheckerType(ctx.checker.getTypeAtLocation(node), node, ctx, fallback);
  } catch {
    return fallback;
  }
}

/** Map an already-printed type string onto something Doxygen can parse. */
function sanitizeTypeText(text, fallback = 'auto') {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  if (t === 'void' || KEYWORD_TYPES_BY_NAME.has(t)) return t;
  if (isSimpleIdentifier(t)) return sanitizeIdentifier(t, fallback);
  // `Foo[]`
  const arr = /^([A-Za-z_][A-Za-z0-9_.]*)\[\]$/.exec(t);
  if (arr) return `Array< ${sanitizeIdentifier(arr[1].split('.').pop(), 'any')} >`;
  // `Promise<Foo>` and friends: keep the head, map the first argument crudely.
  const generic = /^([A-Za-z_][A-Za-z0-9_.]*)<(.+)>$/.exec(t);
  if (generic) {
    const head = sanitizeIdentifier(generic[1].split('.').pop(), 'any');
    const inner = sanitizeTypeText(generic[2], 'any');
    return `${head}< ${inner} >`;
  }
  if (/^".*"$|^'.*'$/.test(t)) return 'string';
  if (/^-?[0-9]/.test(t)) return 'number';
  if (t.includes('|')) {
    const parts = t.split('|').map((p) => sanitizeTypeText(p.trim(), 'any'));
    const kept = [...new Set(parts.filter((p) => p !== 'undefined' && p !== 'null'))];
    if (kept.length === 1) return kept[0];
    return combineNames(kept.length ? kept : parts, '_or_', 'Union');
  }
  if (t.includes('&')) {
    const parts = t.split('&').map((p) => sanitizeTypeText(p.trim(), 'any'));
    return combineNames([...new Set(parts)], '_and_', 'Intersection');
  }
  if (t.includes('=>')) return 'Function';
  if (t.startsWith('{')) return 'object';
  return sanitizeIdentifier(t.split(/[^A-Za-z0-9_]/).filter(Boolean)[0] || fallback, fallback);
}

const KEYWORD_TYPES_BY_NAME = new Set([...KEYWORD_TYPES.values()]);

module.exports = {
  isSimpleIdentifier,
  mapCheckerType,
  qualifyTypeSymbol,
  mapHeritageName,
  mapInferredType,
  mapTypeNode,
  sanitizeTypeText,
  typeSourceText,
};
