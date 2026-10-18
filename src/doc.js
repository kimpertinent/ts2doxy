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
 * HTML elements Doxygen understands inside a comment. A tag of one of these is
 * passed through when it is used as markup (see `planHtml`); any other `<` is
 * escaped, so `Array<T>` in prose stays readable text instead of turning into
 * a stray tag.
 */
const HTML_TAGS = [
  'a', 'b', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'dd',
  'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'ol', 'p', 'pre', 'q',
  's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'var',
];

/** Elements without content or end tag. */
const VOID_TAGS = new Set(['br', 'hr', 'img']);

/**
 * Elements whose end tag may be left out: Doxygen, like HTML, closes them
 * when the element around them ends (`<ul><li>a<li>b</ul>`).
 */
const OPTIONAL_END_TAGS = new Set(['li', 'p', 'dt', 'dd', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot']);

/** A known HTML tag; groups: `/` of an end tag, the name, `/` of `<x/>`. */
const HTML_TAG = `<(/?)(${HTML_TAGS.join('|')})(?:\\s[^<>]*?)?(/?)>`;

/** A known HTML tag, or an HTML entity such as `&amp;` / `&#160;`. */
const HTML_MARKUP = `</?(?:${HTML_TAGS.join('|')})(?:\\s[^<>]*)?/?>`
  + '|&(?:[A-Za-z][A-Za-z0-9]*|#[0-9]+|#[xX][0-9A-Fa-f]+);';

/** Code spans and fences, which escapeText leaves to Doxygen verbatim. */
const CODE_SPANS = /(```[\s\S]*?```|`[^`]*`)/g;

/**
 * Decide, for every known HTML tag in one section of comment text, whether it
 * is markup to pass through or text to escape.
 *
 * Doxygen warns about a tag it cannot pair -- `The <table>.` gives "expected
 * <tr> tag but found TK_WORD token instead!", a lone `</b>` "found </b> tag
 * without matching <b>" -- and the pairing is per section: a `<b>` opened in
 * the description and closed in `@return` warns too. So a section is one run
 * of text Doxygen parses as a unit (a comment's description, or the text of
 * one tag), and within it a tag is kept when
 *   - it is a void tag (`<br>`, `<br/>`, `<hr>`, `<img ...>`), or
 *   - it pairs with its end tag, matched as a stack so that misnested markup
 *     (`<b><i>x</b></i>`) keeps only the pair that nests, or
 *   - its end tag is optional and the element around it is closed
 *     (`<ul><li>a<li>b</ul>`).
 * Everything else is escaped and shows literally. A non-void tag in the
 * empty-tag form (`<b/>`) is escaped too, Doxygen rejects that syntax.
 *
 * @param {string[]} texts the raw pieces of the section, in order (a comment
 *   is escaped piecewise around its `{@link}`s)
 * @returns {{keep: boolean[]}} one decision per tag, consumed in order by
 *   `escapeText`
 */
function planHtml(texts) {
  const tags = [];
  for (const text of texts) {
    String(text || '').split(CODE_SPANS).forEach((part, i) => {
      if (i % 2 === 1) return;
      for (const m of part.matchAll(new RegExp(HTML_TAG, 'gi'))) {
        tags.push({ close: m[1] === '/', name: m[2].toLowerCase(), empty: m[3] === '/' });
      }
    });
  }
  const keep = tags.map(() => false);
  const open = [];
  tags.forEach((tag, i) => {
    if (VOID_TAGS.has(tag.name)) {
      keep[i] = !tag.close;
    } else if (tag.empty) {
      // rejected by Doxygen; stays escaped
    } else if (!tag.close) {
      open.push(i);
    } else {
      const at = open.map((j) => tags[j].name).lastIndexOf(tag.name);
      if (at < 0) return;
      keep[open[at]] = true;
      keep[i] = true;
      // Elements left open inside it end here: implicitly where the end tag
      // is optional, otherwise they were never closed.
      for (const j of open.slice(at + 1)) keep[j] = OPTIONAL_END_TAGS.has(tags[j].name);
      open.length = at;
    }
  });
  return { keep };
}

/**
 * Escape text taken from a source comment so Doxygen reads it as prose.
 *
 * `@`, `\`, `#`, `<`, `>`, `%` and `&` all mean something to Doxygen or to its
 * Markdown layer. Three kinds of text are left alone because they are already
 * meaningful as written: `backtick` spans and fenced code blocks (verbatim for
 * Doxygen), and the inline HTML tags and entities Doxygen supports.
 */
function escapeText(text, plan = planHtml([text])) {
  if (!text) return '';
  // A markdown code span may span lines, and Doxygen renders it as one; the
  // pattern has to match that or the backticks would be escaped apart.
  const parts = String(text).split(CODE_SPANS);
  return parts
    .map((part, i) => {
      // A backtick left over after the paired spans were taken out opens a
      // code span that is never closed. Doxygen 1.18 then reads the rest of
      // the comment -- its `*\/` included -- as verbatim text and loses the
      // declaration; 1.9.8 only mis-renders it. Doxygen has no escape for a
      // backtick and does not decode `&#96;` in prose, so the character is
      // replaced by an apostrophe.
      if (i % 2 === 0) return escapeProse(part, plan).replace(/`/g, "'");
      // Fenced blocks are left as they are: Doxygen turns them into a code
      // block. A single-backtick span becomes `<tt>` instead, because
      // Doxygen's own handling of those is fragile -- an apostrophe in the
      // span makes the opening backtick pair with it as a TeX-style quote,
      // and some contents (`${a}.${b}`) leave the span unterminated, which
      // reports as a stray `</tt>`. `<tt>` renders identically and parses
      // unambiguously.
      if (part.startsWith('```')) return part;
      return escapeInlineCode(part.replace(/^`|`$/g, ''));
    })
    .join('');
}

/**
 * Escape prose, leaving entities and the HTML tags `plan` keeps (by default:
 * those balanced within `text` itself).
 */
function escapeProse(text, plan = planHtml([text])) {
  const parts = String(text).split(new RegExp(`(${HTML_MARKUP})`, 'i'));
  return parts
    .map((part, i) => {
      if (i % 2 === 0) return escapePlain(part);
      if (part.startsWith('&')) return part;
      // `plan` lists the tags of the whole section in order; take this one's.
      return plan.keep.shift() ? part : escapePlain(part);
    })
    .join('');
}

function escapePlain(text) {
  return neutralizeCommentDelimiters(text)
    .replace(/\\/g, '\\\\')
    .replace(/@/g, '\\@')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/%/g, '\\%')
    .replace(/&/g, '\\&')
    .replace(/#/g, '\\#');
}

/**
 * Neutralize comment delimiters in text that goes inside a generated comment.
 *
 * `/*` is the dangerous one: Doxygen's C comment scanner counts nested
 * comments, so a `/**` inside our `/** ... *\/` block -- which happens as soon
 * as a documented TypeScript type carries its own JSDoc, e.g.
 * `readonly pool?: { /** max *\/ max?: number }` -- leaves the comment open
 * and swallows the rest of the file. Separating the two characters with a
 * space is the only form Doxygen renders verbatim: `*\\/` and `/\\*` both
 * print the backslash.
 */
function neutralizeCommentDelimiters(text) {
  return String(text == null ? '' : text)
    .replace(/\/\*/g, '/ *')
    .replace(/\*\//g, '* /');
}

/**
 * Render a fragment as inline code inside a generated comment.
 *
 * Markdown backticks cannot be used for this. Doxygen also supports the
 * TeX-style quotation `` `quoted' ``, so the opening backtick pairs with the
 * first apostrophe in the text instead of with the closing backtick -- and
 * embedded TypeScript is full of apostrophes. The span then falls apart, and
 * whatever it contained (`<monitor>`, `@example`, ...) is interpreted as
 * markup. `<tt>` has no such ambiguity; the content is escaped as prose,
 * which Doxygen resolves back inside the element.
 */
function escapeInlineCode(text) {
  return `<tt>${escapePlain(neutralizeCommentDelimiters(text)).replace(/`/g, "'")}</tt>`;
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
    // The brief is marked explicitly rather than left to JAVADOC_AUTOBRIEF.
    // That heuristic ends the brief at the first `.` that is not followed by
    // a letter -- including one inside an element, which then gets split
    // across brief and detailed description: `<tt>${a}.${b}</tt>` leaves the
    // `<tt>` unclosed in the brief and the `</tt>` orphaned after it. The
    // first paragraph of a JSDoc comment is its summary by convention, so
    // that is what becomes the brief.
    const text = trimBlank(this.text);
    if (text.length) text[0] = `@brief ${text[0]}`;
    pushBlock(text);
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

module.exports = {
  Doc,
  HTML_TAGS,
  escapeInlineCode,
  escapePlain,
  escapeProse,
  escapeText,
  planHtml,
  neutralizeCommentDelimiters,
};
