'use strict';
/**
 * Line-anchored output buffer.
 *
 * Doxygen does *not* honour `#line` directives in filter output (verified
 * against Doxygen 1.9.8), and with `FILTER_SOURCE_FILES = NO` it shows the
 * original TypeScript in the source browser. So "Definition at line N" is only
 * correct if the pseudo-code for a declaration is emitted on the *same line
 * number* as the declaration in the original file.
 *
 * `Canvas` takes code fragments tagged with the source line they belong to and
 * pads the output with blank lines so each fragment lands on its anchor.
 *
 * Two rules make that always possible:
 *   1. A fragment is a single output line, so nothing can straddle anchors
 *      (class open brace and close brace are separate fragments).
 *   2. Documentation blocks are shrunk to fit the free space above the
 *      declaration -- in the worst case to a one-line `/** ... *\/` appended to
 *      the previous output line, which Doxygen still attaches to the
 *      declaration that follows it.
 *
 * Only generated block comments are emitted, never `//` line comments, so
 * appending to an existing line can never comment out code.
 *
 * One thing must NOT share a line, though: a declaration. Doxygen 1.9.8
 * invents cross-references between declarations that sit on the same line --
 * `class P { public: int a(); public: void b(); };` on one line is reported as
 * `P::a -> a, b` -- and two inline member bodies on one line have their calls
 * merged into the first, losing the second one's edges. Separators (`;;`,
 * comments, extra access specifiers) make no difference, and Doxygen ignores
 * `#line`, so the only cure is to put each declaration on a line of its own.
 * Fragments passed `solo: true` therefore start a new line rather than share,
 * which costs the exact line number of every declaration after the first on a
 * compact source line. Closing braces and call statements are safe to share
 * (verified against Doxygen 1.9.8) and still do.
 */

const { neutralizeCommentDelimiters } = require('./doc');

class Canvas {
  constructor() {
    /** @type {{anchor:number, doc:string[], code:string}[]} */
    this.items = [];
    this.drift = 0; // number of fragments that could not be placed on their anchor
  }

  /**
   * Queue one line of code.
   * @param {number} anchor 1-based source line the code should appear on.
   * @param {string} code   single line of C++ pseudo-code.
   * @param {string[]|{variants:Function}} [doc] the documentation block,
   *        placed just above: either ready-made lines, or a `Doc` offering
   *        several renderings to choose from once the free space is known.
   * @param {{shared?: boolean, solo?: boolean}} [opts]
   *        `shared` marks a fragment that may share its line with another and
   *        should not be counted as drift (a closing brace, a call
   *        statement). `solo` marks one that must never share a line: see
   *        below. `synthetic` marks a declaration that has no line in the
   *        original source at all (a constructor the filter invented), so
   *        moving it is not a loss of fidelity.
   */
  put(anchor, code, doc, opts) {
    this.items.push({
      anchor: Math.max(1, anchor | 0),
      code,
      doc: doc || null,
      shared: !!(opts && opts.shared),
      solo: !!(opts && opts.solo),
      synthetic: !!(opts && opts.synthetic),
    });
  }

  /** Render the queued fragments into a single string. */
  render() {
    const out = [];
    const written = () => out.length; // index of the last written line (1-based)
    const appendToLast = (text) => {
      if (!out.length) out.push(text);
      else out[out.length - 1] += (out[out.length - 1] ? ' ' : '') + text;
    };
    const padTo = (line) => {
      while (written() < line) out.push('');
    };

    for (const item of this.items) {
      const variants = docVariants(item.doc);
      if (variants.length) {
        const gap = item.anchor - 1 - written();
        // Take the most faithful rendering that fits in the free space above
        // the declaration; only collapse to one line when none does.
        let doc = variants.find((v) => v.length <= gap);
        if (!doc) doc = [compactDoc(variants[0])];
        if (doc.length <= gap) {
          padTo(item.anchor - 1 - doc.length);
          for (const line of doc) out.push(line);
        } else {
          // gap <= 0: hang the one-line comment off the previous output line.
          appendToLast(doc[0]);
        }
      }
      if (item.anchor > written()) {
        padTo(item.anchor - 1);
        out.push(item.code);
      } else if (item.solo) {
        // Declarations may not share a line (see the note above), so this one
        // starts a new one and gives up its exact line number.
        out.push(item.code);
        if (!item.synthetic) this.drift++;
      } else {
        appendToLast(item.code);
        if (!item.shared) this.drift++;
      }
    }
    return out.length ? out.join('\n') + '\n' : '';
  }
}

/** Candidate renderings of a documentation block, longest first. */
function docVariants(doc) {
  if (!doc) return [];
  if (Array.isArray(doc)) return doc.length ? [doc] : [];
  if (typeof doc.variants === 'function') return doc.variants();
  return [];
}

/**
 * Collapse a multi-line `/** ... *\/` block into a single line.
 *
 * Doxygen ends a command's argument list at the next command, so
 * `@param a x @param b y` on one line still parses, and `@code ... @endcode`
 * stays legal inline -- it only loses its internal line breaks.
 *
 * `@par <title>`, however, takes a title that runs to the end of the line, so
 * everything joined after it would land inside that title and Doxygen rejects
 * commands there ("Illegal command @note found as part of a title section").
 * Such a heading is therefore demoted to plain text when collapsing.
 */
function compactDoc(lines) {
  const body = lines
    .map((l) => l.replace(/^\s*\/\*\*+<?/, '').replace(/\*\/\s*$/, '').replace(/^\s*\*+ ?/, ''))
    .map((l) => l.trim())
    .filter((l) => l.length)
    .map((l) => l.replace(/^@par\s+(.*)$/, (match, title) => `${title.replace(/:$/, '')}:`)
      .replace(/^@par$/, ''))
    .filter((l) => l.length)
    .join(' ');
  return '/** ' + neutralizeCommentDelimiters(body) + ' */';
}

module.exports = { Canvas, compactDoc, docVariants };
