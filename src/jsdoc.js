'use strict';
/**
 * JSDoc / TSDoc -> Doxygen comment conversion.
 *
 * Phase 1 only carries the prose across (escaped). Tag translation lands in
 * phase 2; `buildDoc` is already the single entry point so nothing else has to
 * change then.
 */

const ts = require('typescript');
const { Doc, escapeText } = require('./doc');

/** Tags that mark a comment as describing the file rather than a declaration. */
const FILE_TAGS = new Set(['file', 'fileoverview', 'overview', 'module', 'packageDocumentation']);

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

/** The free-text part of a JSDoc comment, as plain lines. */
function commentLines(comment) {
  if (comment === undefined || comment === null) return [];
  if (typeof comment === 'string') return comment.split(/\r?\n/);
  // ts.NodeArray<ts.JSDocComment>: text parts plus inline link tags.
  const text = comment.map((part) => {
    if (part.kind === ts.SyntaxKind.JSDocText) return part.text;
    return part.getText ? part.getText() : (part.text || '');
  }).join('');
  return text.split(/\r?\n/);
}

/**
 * Build the Doxygen comment for a declaration.
 *
 * @param node declaration node
 * @param ctx  translation context
 * @param info extra material contributed by the translator: `notes` (strings),
 *             `types` (original TypeScript type texts) and `tparams`.
 */
function buildDoc(node, ctx, info = {}) {
  const doc = new Doc();
  for (const block of jsDocNodes(node, ctx)) {
    const lines = commentLines(block.comment);
    if (lines.length) doc.addText(lines.map((l) => escapeText(l)));
  }
  for (const note of info.notes || []) doc.addNote(note);
  return doc;
}

module.exports = { FILE_TAGS, buildDoc, commentLines, findFileComment, jsDocNodes };
