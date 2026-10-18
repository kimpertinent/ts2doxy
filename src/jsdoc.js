'use strict';
/**
 * JSDoc / TSDoc -> Doxygen comment conversion.
 *
 * Two rules drive the design:
 *
 *  - **Nothing may provoke a Doxygen warning.** A warning caused by the filter
 *    is a bug, so `@param` is only emitted for names that really appear in the
 *    emitted signature, `@tparam` only for real template parameters, and
 *    `@ref` only for targets the type checker resolved to a declaration we
 *    translate ourselves. An unresolvable reference or an unknown parameter
 *    name would make Doxygen complain.
 *  - **Nothing may be silently dropped.** Tags with no Doxygen counterpart are
 *    carried over as `@note`s instead of being discarded.
 */

const ts = require('typescript');
const {
  Doc, escapeInlineCode, escapeText, neutralizeCommentDelimiters, planHtml,
} = require('./doc');
const { sanitizeIdentifier } = require('./names');
const { qualifiedNameOfSymbol } = require('./symbols');

/** Tags that may appear only once per argument, even across merged comments. */
const DEDUPED_TAGS = new Set(['param', 'arg', 'argument', 'typeParam', 'returns', 'return']);

/** Tags that mark a comment as describing the file rather than a declaration. */
const FILE_TAGS = new Set(['file', 'fileoverview', 'overview', 'module', 'packageDocumentation']);

/**
 * Tags Doxygen understands under the same name. A `null` command means the
 * body is merged into the description as an ordinary paragraph.
 */
const PASSTHROUGH_TAGS = new Map([
  ['deprecated', 'deprecated'],
  ['since', 'since'],
  ['author', 'author'],
  ['version', 'version'],
  ['copyright', 'copyright'],
  ['date', 'date'],
  ['todo', 'todo'],
  ['warning', 'warning'],
  ['note', 'note'],
  ['remarks', null],
  ['description', null],
  ['summary', null],
  ['desc', null],
]);

/** Tags whose information the generated declaration already carries. */
const REDUNDANT_TAGS = new Set([
  'type', 'typedef', 'callback', 'class', 'constructor', 'constructs',
  'interface', 'enum', 'member', 'memberof', 'namespace', 'function',
  'method', 'readonly', 'static', 'abstract', 'virtual', 'override',
  'public', 'private', 'protected', 'async', 'generator', 'extends',
  'implements', 'augments', 'satisfies', 'inheritdoc', 'inheritDoc',
  'sealed', 'hidden', 'ignore', 'template',
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

/* -------------------------------------------------------------------- *
 * comment bodies
 * -------------------------------------------------------------------- */

/**
 * Reassemble a URL that TypeScript split in two.
 *
 * `{@link https://example.com | Docs}` and `@see https://example.com` are
 * parsed as the identifier `https` followed by the text `://example.com ...`,
 * so the scheme arrives separately from the rest and has to be glued back on
 * before anything can recognise it as a URL.
 *
 * @returns `{url, label}`, or null when this is not a URL reference.
 */
function splitUrlReference(written, text) {
  const joined = `${written || ''}${text || ''}`.trim();
  const match = /^((?:https?|ftp|mailto):[^\s|]+)\s*(?:\|\s*([\s\S]*))?$/.exec(joined);
  if (!match) return null;
  return { url: match[1], label: (match[2] || '').trim() };
}

/** A URL, with a label when one was given, as Doxygen-ready Markdown. */
function renderUrl({ url, label }) {
  if (!label) return url;
  const text = escapeText(label).replace(/[[\]]/g, '');
  return `[${text}](${url})`;
}

function isLinkLike(part) {
  return part.kind === ts.SyntaxKind.JSDocLink
    || part.kind === ts.SyntaxKind.JSDocLinkCode
    || part.kind === ts.SyntaxKind.JSDocLinkPlain;
}

/** Resolve a `{@link Target}` name through the checker. */
function resolveLinkTarget(nameNode, ctx) {
  if (!nameNode || !ctx || !ctx.checker) return null;
  try {
    let symbol = ctx.checker.getSymbolAtLocation(nameNode);
    if (!symbol && nameNode.right) symbol = ctx.checker.getSymbolAtLocation(nameNode.right);
    if (!symbol && nameNode.name) symbol = ctx.checker.getSymbolAtLocation(nameNode.name);
    if (!symbol) return null;
    const qualified = qualifiedNameOfSymbol(symbol, ctx);
    return qualified ? qualified.join('::') : null;
  } catch {
    return null;
  }
}

/**
 * `{@link Target}` -> `@ref ns::Target "label"`.
 *
 * Only symbols we translate ourselves become a reference. Anything else -- a
 * DOM type, a dangling name, a bare URL -- is written as text, because Doxygen
 * warns about references it cannot resolve.
 */
function renderLink(part, ctx) {
  const nameNode = part.name;
  const written = nameNode && nameNode.getText ? nameNode.getText() : '';
  const url = splitUrlReference(written, part.text);
  if (url) return renderUrl(url);
  let label = String(part.text || '').trim().replace(/^\|\s*/, '').trim();
  const target = resolveLinkTarget(nameNode, ctx);
  if (target) {
    // The label is always written out. Doxygen reads the argument of `@ref`
    // up to the next space, so `{@link decrement}: builds` would otherwise
    // become `@ref ns::decrement: builds` and the reference would not
    // resolve -- the punctuation that follows a link is part of the sentence.
    const text = (label || written || target).replace(/"/g, "'");
    return `@ref ${target} "${text}"`;
  }
  if (!written) {
    // `{@link https://example.com}`: Doxygen auto-links bare URLs.
    if (/^(https?|ftp):\/\//.test(label)) return label;
    return escapeText(label);
  }
  // Unresolvable: show it as inline code rather than a dead reference.
  return label ? `${escapeInlineCode(written)} (${escapeText(label)})` : escapeInlineCode(written);
}

/**
 * Render a JSDoc comment body (text plus inline tags) as escaped lines.
 *
 * The body is one section for Doxygen's HTML pairing, but it is escaped piece
 * by piece around its `{@link}`s, so whether an HTML tag is markup is decided
 * once for all pieces (`planHtml`): `<b>see {@link X}</b>` keeps its `<b>`.
 */
function renderComment(comment, ctx) {
  if (comment === undefined || comment === null) return [];
  if (typeof comment === 'string') return escapeText(comment).split(/\r?\n/);
  const textOf = (part) => (part.kind === ts.SyntaxKind.JSDocText
    ? part.text
    : (part.getText ? part.getText() : String(part.text || '')));
  const plan = planHtml(comment.filter((part) => !isLinkLike(part)).map(textOf));
  let buffer = '';
  for (const part of comment) {
    buffer += isLinkLike(part) ? renderLink(part, ctx) : escapeText(textOf(part), plan);
  }
  return buffer.split(/\r?\n/);
}

/** One-line rendering of a comment body, for use as a command argument. */
function renderCommentInline(comment, ctx) {
  return renderComment(comment, ctx).map((l) => l.trim()).filter(Boolean).join(' ');
}

/**
 * Drop the separator of the TSDoc form `@param name - description`.
 *
 * TSDoc writes the hyphen as punctuation between the name and the
 * description, so it is not part of the description itself.
 */
function stripTsdocSeparator(text) {
  return String(text || '').replace(/^[-\u2013\u2014]\s+/, '');
}

/** Unescaped comment text, for bodies that end up inside `@code`. */
function rawCommentText(comment) {
  if (comment === undefined || comment === null) return '';
  if (typeof comment === 'string') return comment;
  return comment.map((part) => {
    if (part.kind === ts.SyntaxKind.JSDocText) return part.text;
    if (isLinkLike(part)) {
      const written = part.name && part.name.getText ? part.name.getText() : '';
      const text = String(part.text || '').trim();
      // `https` + `://host` is one URL, not a name followed by a description.
      const separator = /^:\/\//.test(text) ? '' : ' ';
      return [written, text].filter(Boolean).join(separator);
    }
    return part.text || '';
  }).join('');
}

/**
 * Top-level `@param` names in a declaration's JSDoc, in order and deduplicated.
 *
 * Used to give a destructured parameter the name its documentation uses: the
 * emitted signature cannot destructure, so `{ maxAliasLength }: Driver`
 * becomes one parameter, and calling it `arg0` while the JSDoc documents
 * `@param driver` leaves it undocumented as far as Doxygen is concerned.
 */
function documentedParamNames(node, ctx) {
  const names = [];
  for (const block of jsDocNodes(node, ctx)) {
    for (const tag of block.tags || []) {
      const tagName = tag.tagName ? tag.tagName.text : '';
      if (tagName !== 'param' && tagName !== 'arg' && tagName !== 'argument') continue;
      const written = tag.name && tag.name.getText ? tag.name.getText() : '';
      const bare = written.replace(/^\.\.\./, '').replace(/^\[/, '').replace(/\]$/, '');
      if (!bare || bare.includes('.')) continue; // a member of a destructured object
      if (!names.includes(bare)) names.push(bare);
    }
  }
  return names;
}

/** The type written in a JSDoc type expression, e.g. the `number` of `{number}`. */
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

/**
 * `@example` -> `@par Example` plus `@code{.js} ... @endcode`.
 *
 * Text before a fenced code block becomes the caption; the fence markers
 * themselves are dropped, since `@code` already delimits the block. The body
 * is taken from the raw comment text: inside `@code` everything is verbatim,
 * so it must not be escaped.
 */
function renderExample(tag) {
  const lines = rawCommentText(tag.comment).split(/\r?\n/);
  const fenced = lines.some((l) => /^\s*(```|~~~)/.test(l));
  const caption = [];
  const code = [];
  let seenFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      seenFence = true;
      continue;
    }
    if (!fenced || seenFence) code.push(line.replace(/\s+$/, ''));
    else caption.push(line.trim());
  }
  const body = code;
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const title = caption.filter(Boolean).join(' ').trim();
  const out = [title ? `@par Example: ${escapeText(title)}` : '@par Example'];
  if (body.length) {
    out.push('@code{.js}');
    for (const line of body) out.push(neutralizeCommentDelimiters(line));
    out.push('@endcode');
  }
  return out;
}

/**
 * `@see` targets.
 *
 * TypeScript parses the argument into `tag.name` (a name reference) plus
 * `tag.comment`, and splits a URL between the two, so both halves have to be
 * considered. Doxygen resolves a bare name in `@see` as a reference and warns
 * when it cannot, so a name is only passed through once the checker has
 * resolved it; an unresolvable one becomes a "See also" note instead. URLs and
 * `@ref`s are fine as they are.
 */
function renderSee(tag, ctx, doc) {
  const written = tag.name && tag.name.getText ? tag.name.getText() : '';
  // After `@see Name` TypeScript hands us the leading `*` of the next comment
  // line as the tag's description; that is trivia, not text.
  const isTrivia = (text) => /^[\s*]*$/.test(String(text || ''));
  const rawRest = isTrivia(rawCommentText(tag.comment)) ? '' : rawCommentText(tag.comment);
  const rest = isTrivia(renderCommentInline(tag.comment, ctx))
    ? ''
    : renderCommentInline(tag.comment, ctx);

  const url = splitUrlReference(written, rawRest);
  if (url) {
    doc.addCommand(`@see ${renderUrl(url)}`);
    return;
  }

  const target = resolveLinkTarget(tag.name, ctx);
  if (target) {
    doc.addCommand(`@see ${target}${rest ? ` ${rest}` : ''}`);
    return;
  }

  const body = [escapeText(written), rest].filter(Boolean).join(' ').trim();
  if (!body) return;
  if (body.startsWith('@ref ')) {
    // Keep the `@ref`: `@see @ref ns::X "label"` renders as a link carrying
    // that label, while `@see ns::X "label"` would print the label as text.
    doc.addCommand(`@see ${body}`);
    return;
  }
  // Already a link: a bare URL or a Markdown link produced by an inline
  // `{@link}`. Doxygen renders either inside the "See also" section.
  if (/^(?:https?|ftp|mailto):\S+$/.test(body) || /^\[[^\]]*\]\([^()\s]+\)$/.test(body)) {
    doc.addCommand(`@see ${body}`);
    return;
  }
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(body)) {
    const resolved = resolveIdentifierInScope(body, tag, ctx);
    if (resolved) {
      doc.addCommand(`@see ${resolved}`);
      return;
    }
  }
  doc.addNote(`@note See also: ${body}`);
}

/** Resolve a dotted name written in a comment, relative to that comment. */
function resolveIdentifierInScope(text, tag, ctx) {
  if (!ctx || !ctx.checker) return null;
  const head = text.split('.')[0];
  try {
    const symbols = ctx.checker.getSymbolsInScope(
      tag,
      ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace,
    );
    const match = symbols.find((s) => s.name === head);
    if (!match) return null;
    const qualified = qualifiedNameOfSymbol(match, ctx);
    if (!qualified) return null;
    const rest = text.split('.').slice(1).map((p) => sanitizeIdentifier(p, ''));
    return [...qualified, ...rest].filter(Boolean).join('::');
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------- *
 * the converter
 * -------------------------------------------------------------------- */

/**
 * Build the Doxygen comment for a declaration.
 *
 * @param node declaration node (or `{jsDoc: [...]}` for a file comment)
 * @param ctx  translation context
 * @param info extra material from the translator:
 *             `notes` -- strings appended at the end;
 *             `paramNames` -- Set of parameter names in the emitted signature
 *             (`@param` for anything else would warn);
 *             `typeParamNames` -- Set, same idea for `@tparam`;
 *             `returnsVoid` -- suppresses `@return`.
 */
function buildDoc(node, ctx, info = {}) {
  const doc = new Doc();
  const paramNames = info.paramNames || new Set();
  const typeParamNames = info.typeParamNames || new Set();
  const undocumentable = [];

  // `mergeFrom` carries the comments of declarations that collapsed onto this
  // one (overloads whose emitted signatures are identical), so their
  // documentation is not lost.
  const blocks = [
    ...jsDocNodes(node, ctx),
    ...(info.mergeFrom || []).flatMap((other) => jsDocNodes(other, ctx)),
  ];
  const seenTags = new Set();
  for (const block of blocks) {
    const lines = renderComment(block.comment, ctx);
    if (lines.length) doc.addText(lines);

    for (const tag of block.tags || []) {
      const name = tag.tagName ? tag.tagName.text : '';
      const body = renderCommentInline(tag.comment, ctx);
      // A merged overload documents the same parameters again; Doxygen
      // rejects a second `@param` for one argument.
      if (DEDUPED_TAGS.has(name)) {
        const key = `${name}:${tag.name && tag.name.getText ? tag.name.getText() : ''}`;
        if (seenTags.has(key)) continue;
        seenTags.add(key);
      }

      switch (name) {
        case 'param':
        case 'arg':
        case 'argument': {
          const written = tag.name && tag.name.getText ? tag.name.getText() : '';
          const bare = written.replace(/^\.\.\./, '').replace(/^\[/, '').replace(/\]$/, '');
          const identifier = sanitizeIdentifier(bare, '');
          const optional = !!tag.isBracketed;
          const text = [stripTsdocSeparator(body), optional ? '(optional)' : null]
            .filter(Boolean).join(' ');
          if (identifier && paramNames.has(identifier)) {
            doc.addCommand(`@param ${identifier} ${text}`.trimEnd());
          } else if (written) {
            // A destructured member (`options.width`) or a renamed parameter:
            // `@param` would make Doxygen warn about an unknown argument.
            undocumentable.push(`${escapeInlineCode(written)}: ${text}`.trimEnd());
          }
          break;
        }

        case 'returns':
        case 'return': {
          if (!body) break;
          if (info.returnsVoid) doc.addNote(`@note Returns: ${body}`);
          else doc.addCommand(`@return ${body}`);
          break;
        }

        case 'throws':
        case 'exception': {
          // Doxygen reads the first token as the exception object, so the
          // type is emitted bare. A compound type (`A | B`) has no single
          // object, so it goes into the description instead.
          const written = typeExpressionText(tag);
          const simple = written && /^[A-Za-z_][\w.]*$/.test(written) ? written : null;
          const text = [
            simple,
            !simple && written ? escapeInlineCode(written) : null,
            body,
          ].filter(Boolean).join(' ');
          doc.addCommand(`@throws ${text}`.trimEnd());
          break;
        }

        case 'example':
          for (const line of renderExample(tag)) doc.addCommand(line);
          break;

        case 'see':
          renderSee(tag, ctx, doc);
          break;

        case 'typeParam': {
          // TypeScript has no node type for `@typeParam`, so the parameter
          // name is the first word of the comment rather than `tag.name`.
          let written = tag.name && tag.name.getText ? tag.name.getText() : '';
          let text = body;
          if (!written) {
            const split = /^(\S+)\s*([\s\S]*)$/.exec(body);
            if (split) {
              [, written, text] = split;
            }
          }
          text = stripTsdocSeparator(text);
          const identifier = sanitizeIdentifier(written, '');
          if (identifier && typeParamNames.has(identifier)) {
            doc.addCommand(`@tparam ${identifier} ${text}`.trimEnd());
          } else if (written) {
            doc.addNote(`@note Type parameter ${escapeInlineCode(written)}: ${text}`.trimEnd());
          }
          break;
        }

        case 'defaultValue':
        case 'default':
          doc.addNote(`@note Default value: ${body || escapeInlineCode(tagSourceText(tag))}`);
          break;

        case 'internal':
        case 'alpha':
        case 'beta':
        case 'experimental':
          doc.addNote(
            `@note Marked ${escapeInlineCode(`@${name}`)} in the TypeScript source.`
            + (body ? ` ${body}` : ''),
          );
          break;

        case 'group':
        case 'category':
          if (body) doc.addNote(`@note ${escapeInlineCode(`@${name}`)}: ${body}`);
          break;

        default: {
          if (PASSTHROUGH_TAGS.has(name)) {
            const command = PASSTHROUGH_TAGS.get(name);
            if (!body) break;
            if (command === null) doc.addText(['', ...renderComment(tag.comment, ctx)]);
            else doc.addCommand(`@${command} ${body}`);
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

  if (undocumentable.length) {
    // One `@note`, not a `@par` list: a command keeps the preceding `@return`
    // description from swallowing it when the block has to be collapsed onto
    // a single line.
    doc.addNote(`@note Documented TypeScript parameters: ${undocumentable.join('; ')}`);
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
  documentedParamNames,
  PASSTHROUGH_TAGS,
  REDUNDANT_TAGS,
  buildDoc,
  findFileComment,
  jsDocNodes,
  rawCommentText,
  renderComment,
  renderCommentInline,
  splitUrlReference,
  stripTsdocSeparator,
};
