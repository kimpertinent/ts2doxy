'use strict';
/**
 * JSDoc / TSDoc -> Doxygen comment conversion.
 *
 * Two rules drive the design:
 *
 *  - Nothing may provoke a Doxygen warning. `@param` is therefore only emitted
 *    for names that actually appear in the emitted signature, and `\ref` only
 *    for targets resolved to a declaration we translate ourselves -- an
 *    unresolvable `\ref` or an unknown parameter name is a warning, and a
 *    warning caused by the filter is a bug.
 *  - Nothing may be silently dropped. Tags without a Doxygen counterpart are
 *    carried over as `@note`s rather than discarded.
 */

const ts = require('typescript');
const { Doc, escapeInlineCode, escapeText } = require('./doc');
const { sanitizeIdentifier } = require('./names');
const { qualifiedNameOfSymbol } = require('./symbols');

/** Tags that mark a comment as describing the file rather than a declaration. */
const FILE_TAGS = new Set(['file', 'fileoverview', 'overview', 'module', 'packageDocumentation']);

/** Tags passed straight through because Doxygen understands them as written. */
const PASSTHROUGH_TAGS = new Map([
  ['deprecated', 'deprecated'],
  ['see', 'see'],
  ['since', 'since'],
  ['author', 'author'],
  ['version', 'version'],
  ['copyright', 'copyright'],
  ['date', 'date'],
  ['todo', 'todo'],
  ['warning', 'warning'],
  ['note', 'note'],
  ['remarks', null], // body becomes an ordinary paragraph
  ['description', null],
  ['summary', null],
]);

/** Tags whose information is already expressed by the emitted pseudo-code. */
const REDUNDANT_TAGS = new Set([
  'type', 'typedef', 'callback', 'class', 'constructor', 'interface', 'enum',
  'member', 'memberof', 'namespace', 'function', 'method', 'readonly',
  'static', 'abstract', 'virtual', 'override', 'public', 'private',
  'protected', 'async', 'generator', 'extends', 'implements', 'augments',
  'satisfies', 'inheritdoc', 'inheritDoc', 'sealed', 'hidden', 'ignore',
  ...FILE_TAGS,
]);

/** The JSDoc blocks attached to a declaration, if any. */
function jsDocNodes(node, ctx) {
  const direct = node.jsDoc;
  if (!direct || !direct.length) return [];
  if (ctx && ctx.skipJsDoc && ctx.skipJsDoc.size) {
    return direct.filter((block) => !ctx.skipJsDoc.has(block));
  }
  return direct;
}

/**
 * Find the leading comment that documents the *file* rather than the first
 * declaration in it. TypeScript attaches such a comment to whatever statement
 * follows it, which would otherwise put the module overview on the first
 * class in the file.
 *
 * It counts as a file comment when it carries `@file`/`@module`/..., when the
 * statement has a second JSDoc block of its own, or when a blank line
 * separates it from the declaration (the usual convention).
 */
function findFileComment(sourceFile) {
  const first = sourceFile.statements[0];
  if (!first) return null;
  const blocks = first.jsDoc;
  if (!blocks || !blocks.length) return null;
  const block = blocks[0];
  if (blocks.length > 1) return block;
  const tags = block.tags || [];
  if (tags.some((t) => t.tagName && FILE_TAGS.has(t.tagName.text))) return block;
  const between = sourceFile.text.slice(block.end, first.getStart(sourceFile, false));
  if (/\n[ \t]*\n/.test(between)) return block;
  return null;
}

function isLinkLike(part) {
  return part.kind === ts.SyntaxKind.JSDocLink
    || part.kind === ts.SyntaxKind.JSDocLinkCode
    || part.kind === ts.SyntaxKind.JSDocLinkPlain;
}

/**
 * `{@link Target}` -> `\ref ns::Target "label"`.
 *
 * Only symbols we translate ourselves become a `\ref`; anything else (a DOM
 * type, a URL, a dangling name) is written as plain text, because Doxygen
 * warns about references it cannot resolve.
 */
function renderLink(part, ctx) {
  const nameNode = part.name;
  let label = String(part.text || '').trim().replace(/^[|]\s*/, '').trim();
  let target = null;
  if (nameNode && ctx && ctx.checker) {
    try {
      let symbol = ctx.checker.getSymbolAtLocation(nameNode);
      if (!symbol && nameNode.right) symbol = ctx.checker.getSymbolAtLocation(nameNode.right);
      if (symbol) {
        const qualified = qualifiedNameOfSymbol(symbol, ctx);
        if (qualified) target = qualified.join('::');
      }
    } catch { /* unresolvable: fall through to plain text */ }
  }
  const written = nameNode && nameNode.getText ? nameNode.getText() : '';
  if (!label) label = written;
  if (target) {
    return label && label !== target
      ? `@ref ${target} "${label.replace(/"/g, "'")}"`
      : `@ref ${target}`;
  }
  if (!written && label) {
    // `{@link https://example.com}`: Doxygen auto-links bare URLs.
    return /^(https?|ftp):\/\//.test(label) ? label : escapeText(label);
  }
  return escapeInlineCode(label || written);
}

/** Render a JSDoc comment body (text plus inline tags) as plain lines. */
function renderComment(comment, ctx) {
  if (comment === undefined || comment === null) return [];
  if (typeof comment === 'string') return escapeText(comment).split(/\r?\n/);
  let buffer = '';
  for (const part of comment) {
    if (part.kind === ts.SyntaxKind.JSDocText) {
      buffer += escapeText(part.text);
    } else if (isLinkLike(part)) {
      buffer += renderLink(part, ctx);
    } else {
      buffer += escapeText(part.getText ? part.getText() : String(part.text || ''));
    }
  }
  return buffer.split(/\r?\n/);
}

/** One-line rendering of a comment body, for use inside a command. */
function renderCommentInline(comment, ctx) {
  return renderComment(comment, ctx).map((l) => l.trim()).filter(Boolean).join(' ');
}

/** The type written in a JSDoc type expression, e.g. `{number}`. */
function typeExpressionText(tag) {
  const expr = tag.typeExpression;
  if (!expr) return null;
  const type = expr.type || expr;
  try {
    return type.getText().replace(/\s+/g, ' ').trim();
  } catch {
    return null;
  }
}

/** `@example` bodies become `@code ... @endcode`, fences stripped. */
function renderExample(tag, ctx) {
  const lines = renderComment(tag.comment, ctx);
  const caption = [];
  const code = [];
  let inFence = false;
  let sawFence = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const fence = /^\s*(```|~~~)/.test(line);
    if (fence) {
      inFence = !inFence;
      sawFence = true;
      continue;
    }
    if (inFence || sawFence) code.push(line);
    else if (line.trim()) caption.push(line.trim());
    else if (code.length) code.push(line);
    else caption.push('');
  }
  const body = (sawFence ? code : lines).slice();
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const out = [];
  const title = caption.join(' ').trim();
  out.push(title ? `@par Example: ${title}` : '@par Example');
  out.push('@code{.js}');
  // The text went through escapeText; undo it, code blocks are verbatim.
  for (const line of body) out.push(unescapeText(line));
  out.push('@endcode');
  return out;
}

/** Inverse of doc.escapeProse, for text that ends up inside `@code`. */
function unescapeText(line) {
  return String(line)
    .replace(/\\([@<>%&#\\])/g, '$1')
    .replace(/\*\\\//g, '*/');
}

/**
 * Build the Doxygen comment for a declaration.
 *
 * @param node declaration node (or `{jsDoc: [...]}` for a file comment)
 * @param ctx  translation context
 * @param info extra material from the translator:
 *             `notes` (strings appended at the end),
 *             `paramNames` (Set of parameter names present in the emitted
 *             signature -- `@param` for anything else would warn),
 *             `typeParamNames` (Set, same idea for `@tparam`),
 *             `returnsVoid` (suppresses `@return`).
 */
function buildDoc(node, ctx, info = {}) {
  const doc = new Doc();
  const paramNames = info.paramNames || new Set();
  const typeParamNames = info.typeParamNames || new Set();
  const extraParams = [];

  for (const block of jsDocNodes(node, ctx)) {
    const lines = renderComment(block.comment, ctx);
    if (lines.length) doc.addText(lines);

    for (const tag of block.tags || []) {
      const name = tag.tagName ? tag.tagName.text : '';
      const body = renderCommentInline(tag.comment, ctx);

      switch (name) {
        case 'param':
        case 'arg':
        case 'argument': {
          const written = tag.name && tag.name.getText ? tag.name.getText() : '';
          const bare = written.replace(/^\.\.\./, '').replace(/^\[|\]$/g, '');
          const identifier = sanitizeIdentifier(bare, '');
          const optional = tag.isBracketed || /^\[.*\]$/.test(written);
          const extra = [
            optional ? 'optional' : null,
            tag.name && tag.name.kind === ts.SyntaxKind.QualifiedName ? null : null,
          ].filter(Boolean);
          const text = [body, extra.length ? `(${extra.join(', ')})` : null]
            .filter(Boolean).join(' ');
          if (identifier && paramNames.has(identifier)) {
            doc.addCommand(`@param ${identifier} ${text}`.trimEnd());
          } else if (written) {
            // A destructured or renamed parameter: documenting it with
            // `@param` would make Doxygen warn about an unknown argument.
            extraParams.push(`- ${escapeInlineCode(written)} ${text}`.trimEnd());
          }
          break;
        }

        case 'returns':
        case 'return': {
          if (info.returnsVoid) {
            if (body) doc.addNote(`@note Returns: ${body}`);
          } else {
            doc.addCommand(`@return ${body}`.trimEnd());
          }
          break;
        }

        case 'throws':
        case 'exception': {
          const type = typeExpressionText(tag);
          doc.addCommand(`@throws ${[type, body].filter(Boolean).join(' ')}`.trimEnd());
          break;
        }

        case 'example': {
          for (const line of renderExample(tag, ctx)) doc.addCommand(line);
          break;
        }

        case 'typeParam':
        case 'template': {
          const written = tag.name && tag.name.getText ? tag.name.getText() : '';
          const identifier = sanitizeIdentifier(written, '');
          if (identifier && typeParamNames.has(identifier)) {
            doc.addCommand(`@tparam ${identifier} ${body}`.trimEnd());
          } else if (written) {
            doc.addNote(`@note Type parameter ${escapeInlineCode(written)}: ${body}`.trimEnd());
          }
          break;
        }

        case 'defaultValue':
        case 'default': {
          doc.addNote(`@note Default value: ${body || escapeInlineCode(tagSourceText(tag))}`);
          break;
        }

        case 'internal':
        case 'alpha':
        case 'beta':
        case 'experimental': {
          doc.addNote(`@note Marked ${escapeInlineCode(`@${name}`)} in the TypeScript source.${body ? ` ${body}` : ''}`);
          break;
        }

        case 'group':
        case 'category':
        case 'packageDocumentation':
          if (body) doc.addNote(`@note ${escapeInlineCode(`@${name}`)}: ${body}`);
          break;

        default: {
          if (PASSTHROUGH_TAGS.has(name)) {
            const command = PASSTHROUGH_TAGS.get(name);
            if (command === null) {
              if (body) doc.addText(['', ...renderComment(tag.comment, ctx)]);
            } else if (body) {
              doc.addCommand(`@${command} ${body}`);
            }
          } else if (REDUNDANT_TAGS.has(name)) {
            // Already expressed by the generated declaration.
          } else if (name) {
            doc.addNote(`@note ${escapeInlineCode(`@${name}`)}${body ? ` ${body}` : ''}`);
          }
          break;
        }
      }
    }
  }

  if (extraParams.length) {
    doc.addCommand('@par Parameter details');
    for (const line of extraParams) doc.addCommand(line);
  }
  for (const note of info.notes || []) doc.addNote(note);
  return doc;
}

function tagSourceText(tag) {
  try {
    return tag.getText().replace(/^@\w+\s*/, '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

module.exports = {
  FILE_TAGS,
  PASSTHROUGH_TAGS,
  REDUNDANT_TAGS,
  buildDoc,
  findFileComment,
  jsDocNodes,
  renderComment,
  renderCommentInline,
};
