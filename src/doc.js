'use strict';
/**
 * Assembling Doxygen comment blocks.
 *
 * A `Doc` collects a brief line, free text, Doxygen commands and "notes", and
 * renders them as a `/** ... *\/` block. Rendering is deliberately separate
 * from placement: the canvas decides how many lines the block may occupy and
 * may collapse it (see canvas.js).
 */

/**
 * Escape text taken from a source comment so Doxygen reads it as prose.
 *
 * `@`, `\`, `#`, `<`, `>`, `%`, `&` and `|` all mean something to Doxygen or to
 * its Markdown layer. Text inside `backtick` spans and fenced code blocks is
 * left alone, since that is already verbatim for Doxygen.
 */
function escapeText(text) {
  if (!text) return '';
  const parts = String(text).split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : escapeProse(part)))
    .join('');
}

function escapeProse(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\*\//g, '*\\/')
    .replace(/@/g, '\\@')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/%/g, '\\%')
    .replace(/&/g, '\\&')
    .replace(/#/g, '\\#');
}

/** Escape a fragment that will be shown as inline code (`\c foo` style). */
function escapeInlineCode(text) {
  return '`' + String(text == null ? '' : text).replace(/`/g, "'").replace(/\*\//g, '*\\/') + '`';
}

class Doc {
  constructor() {
    /** @type {string[]} free-text paragraph lines (already escaped) */
    this.text = [];
    /** @type {string[]} Doxygen command lines, e.g. `@param x ...` */
    this.commands = [];
    /** @type {string[]} trailing notes about the TypeScript original */
    this.notes = [];
  }

  /**
   * Append already-escaped prose.
   *
   * Entries are split on newlines: the canvas budgets space by counting them,
   * so one entry has to mean one output line.
   */
  addText(lines) {
    for (const line of [].concat(lines)) {
      if (line === undefined || line === null) continue;
      for (const part of String(line).split('\n')) this.text.push(part);
    }
  }

  /** Append a Doxygen command line such as `@param name description`. */
  addCommand(line) {
    if (!line) return;
    for (const part of String(line).split('\n')) this.commands.push(part);
  }

  /**
   * Append a `@note`-style remark about the TypeScript source.
   *
   * The leading word of these generated remarks is prefixed with `%`, which
   * stops Doxygen's `AUTOLINK_SUPPORT` from turning boilerplate such as
   * "Default value" or "Exported" into a link to a class that happens to
   * carry that name.
   */
  addNote(line) {
    if (!line) return;
    const guarded = String(line).replace(/^(@\w+ +)([A-Z][A-Za-z0-9_]*)/, '$1%$2');
    for (const part of guarded.split('\n')) this.notes.push(part);
  }

  get isEmpty() {
    return !this.text.length && !this.commands.length && !this.notes.length;
  }

  /**
   * Render as comment lines. Returns an empty array when there is nothing to
   * say, so undocumented entities simply get no comment (`EXTRACT_ALL` still
   * lists them).
   */
  render() {
    if (this.isEmpty) return [];
    const body = [];
    const pushBlock = (lines) => {
      if (!lines.length) return;
      if (body.length && body[body.length - 1] !== '') body.push('');
      for (const l of lines) body.push(l);
    };
    pushBlock(trimBlank(this.text));
    pushBlock(this.commands);
    pushBlock(this.notes);
    while (body.length && body[body.length - 1] === '') body.pop();
    if (!body.length) return [];
    if (body.length === 1) return [`/** ${body[0]} */`];
    return ['/**', ...body.map((l) => (l ? ` * ${l}` : ' *')), ' */'];
  }
}

function trimBlank(lines) {
  const out = lines.slice();
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

module.exports = { Doc, escapeInlineCode, escapeText, escapeProse };
