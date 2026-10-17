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
 * HTML elements Doxygen understands inside a comment. A `<` that opens one of
 * these is left alone; any other `<` is escaped, so `Array<T>` in prose stays
 * readable text instead of turning into a stray tag.
 */
const HTML_TAGS = [
  'a', 'b', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'dd',
  'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'ol', 'p', 'pre', 'q',
  's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var',
];

/** A known HTML tag, or an HTML entity such as `&amp;` / `&#160;`. */
const HTML_MARKUP = `</?(?:${HTML_TAGS.join('|')})(?:\\s[^<>]*)?/?>`
  + '|&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);';

/**
 * Escape text taken from a source comment so Doxygen reads it as prose.
 *
 * `@`, `\`, `#`, `<`, `>`, `%` and `&` all mean something to Doxygen or to its
 * Markdown layer. Three kinds of text are left alone because they are already
 * meaningful as written: `backtick` spans and fenced code blocks (verbatim for
 * Doxygen), and the inline HTML tags and entities Doxygen supports.
 */
function escapeText(text) {
  if (!text) return '';
  const parts = String(text).split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) => (i % 2 === 1 ? part : escapeProse(part)))
    .join('');
}

function escapeProse(text) {
  const parts = String(text).split(new RegExp(`(${HTML_MARKUP})`, 'i'));
  return parts
    .map((part, i) => (i % 2 === 1 ? part : escapePlain(part)))
    .join('');
}

function escapePlain(text) {
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
   * Render as comment lines.
   *
   * @param {object} [opts] how hard to squeeze:
   *   `separators` -- blank line between description, commands and notes;
   *   `notesInline` -- generated notes joined onto the last body line;
   *   `openInline` -- first body line shares the `/**` line;
   *   `closeInline` -- `*\/` shares the last body line.
   *
   * Returns an empty array when there is nothing to say, so undocumented
   * entities simply get no comment (`EXTRACT_ALL` still lists them).
   */
  renderAs(opts = {}) {
    const {
      separators = true, notesInline = false, openInline = false, closeInline = false,
    } = opts;
    if (this.isEmpty) return [];
    const body = [];
    const pushBlock = (lines) => {
      if (!lines.length) return;
      if (separators && body.length && body[body.length - 1] !== '') body.push('');
      for (const l of lines) body.push(l);
    };
    pushBlock(trimBlank(this.text));
    pushBlock(this.commands);
    const notes = this.notes.filter((l) => l && l.trim());
    if (notesInline && notes.length && body.length) {
      body[body.length - 1] = `${body[body.length - 1]} ${notes.join(' ')}`.trim();
    } else {
      pushBlock(notes);
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    if (!body.length) return [];
    if (body.length === 1) return [`/** ${body[0]} */`];

    const lines = body.map((l) => (l ? ` * ${l}` : ' *'));
    if (openInline) lines[0] = `/**${lines[0].slice(2)}`;
    else lines.unshift('/**');
    if (closeInline) lines[lines.length - 1] = `${lines[lines.length - 1]} */`;
    else lines.push(' */');
    return lines;
  }

  /** The most faithful rendering. */
  render() {
    return this.renderAs();
  }

  /**
   * Renderings from the most faithful to the most compact.
   *
   * A declaration is emitted on its original source line, so its comment only
   * has the lines the original comment occupied to live in -- and the
   * converted comment is often longer, because `@example` gains
   * `@code`/`@endcode` wrappers and because notes about the TypeScript
   * original are added. Rather than collapsing the whole block onto one line
   * as soon as it does not fit, the canvas walks this ladder and takes the
   * first rendering that does: blank separators go first, then the added
   * notes move onto the last comment line, then the comment delimiters do.
   * The description, its paragraphs and lists, and the line structure of code
   * examples survive all of them.
   */
  variants() {
    const out = [];
    const seen = new Set();
    const add = (lines) => {
      if (!lines.length) return;
      const key = lines.join('\n');
      if (seen.has(key)) return;
      seen.add(key);
      out.push(lines);
    };
    add(this.renderAs({ separators: true }));
    add(this.renderAs({ separators: false }));
    add(this.renderAs({ separators: false, notesInline: true }));
    add(this.renderAs({ separators: false, notesInline: true, openInline: true }));
    add(this.renderAs({
      separators: false, notesInline: true, openInline: true, closeInline: true,
    }));
    return out;
  }
}

function trimBlank(lines) {
  const out = lines.slice();
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

module.exports = { Doc, HTML_TAGS, escapeInlineCode, escapePlain, escapeProse, escapeText };
