'use strict';
/**
 * Identifier / namespace naming rules.
 *
 * Everything the filter emits has to be a legal C++ identifier, because
 * Doxygen parses the output with its C++ parser. These helpers are the single
 * place where TypeScript names and file paths are turned into such
 * identifiers, so that two different invocations of the filter (Doxygen calls
 * us once per file) always agree on the qualified name of a symbol.
 */

const path = require('path');

/** Values of `--namespace-mode`. */
const NAMESPACE_MODES = ['path', 'flat', 'single', 'none'];

/** Extensions we strip when deriving a namespace from a file name. */
const SOURCE_EXTENSIONS = [
  '.d.ts', '.d.mts', '.d.cts',
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
];

/**
 * C++ keywords (plus a few Doxygen-significant words). A TS name or path
 * segment that collides with one of these gets a trailing underscore,
 * otherwise the emitted pseudo-code would not parse.
 */
const CPP_KEYWORDS = new Set([
  'alignas', 'alignof', 'and', 'and_eq', 'asm', 'auto', 'bitand', 'bitor',
  'bool', 'break', 'case', 'catch', 'char', 'char8_t', 'char16_t', 'char32_t',
  'class', 'compl', 'concept', 'const', 'consteval', 'constexpr', 'constinit',
  'const_cast', 'continue', 'co_await', 'co_return', 'co_yield', 'decltype',
  'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum',
  'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto',
  'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'noexcept',
  'not', 'not_eq', 'nullptr', 'operator', 'or', 'or_eq', 'private',
  'protected', 'public', 'register', 'reinterpret_cast', 'requires', 'return',
  'short', 'signed', 'sizeof', 'static', 'static_assert', 'static_cast',
  'struct', 'switch', 'template', 'this', 'thread_local', 'throw', 'true',
  'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned', 'using',
  'virtual', 'void', 'volatile', 'wchar_t', 'while', 'xor', 'xor_eq',
]);

/** Turn an arbitrary string into a single legal C++ identifier. */
function sanitizeIdentifier(raw, fallback = 'anonymous') {
  let s = String(raw == null ? '' : raw);
  s = s.replace(/[^A-Za-z0-9_]/g, '_');
  s = s.replace(/_{3,}/g, '__');
  if (!s || /^_+$/.test(s)) s = fallback;
  if (/^[0-9]/.test(s)) s = '_' + s;
  if (CPP_KEYWORDS.has(s)) s = s + '_';
  return s;
}

/** Strip a known TS/JS extension from a path. */
function stripSourceExtension(p) {
  for (const ext of SOURCE_EXTENSIONS) {
    if (p.toLowerCase().endsWith(ext)) return p.slice(0, -ext.length);
  }
  const ext = path.extname(p);
  return ext ? p.slice(0, -ext.length) : p;
}

/**
 * Derive the namespace path for a source file.
 *
 * `src/util/text.ts` under root `/proj` becomes `['src','util','text']`, which
 * is emitted as `namespace src { namespace util { namespace text {`.
 * A trailing `index` segment is dropped, so `src/util/index.ts` is
 * `['src','util']` -- that is what readers expect from a module path.
 *
 * `mode` is one of:
 *   - `path` (default): mirror the directory structure.
 *   - `flat`: one namespace per file, segments joined with `_`.
 *   - `single`: one namespace, `singleName`, for the whole project.
 *   - `none`: no namespace at all (everything lands in the global scope).
 */
function namespaceSegmentsForFile(fileName, rootDir, mode = 'path', singleName = null) {
  if (mode === 'none') return [];
  if (mode === 'single') return [singleName || 'project'];
  let rel = path.relative(rootDir, fileName);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    // Outside the project root (a sibling package, a linked dependency, ...).
    // Keep it addressable but clearly separated.
    rel = path.join('external', rel.replace(/^(\.\.[\\/])+/, ''));
  }
  rel = stripSourceExtension(rel);
  let segments = rel.split(/[\\/]+/).filter(Boolean).filter((s) => s !== '.');
  if (segments.length > 1 && /^index$/i.test(segments[segments.length - 1])) {
    segments.pop();
  }
  segments = segments.map((s) => sanitizeIdentifier(s, 'module'));
  if (!segments.length) segments = ['module'];
  if (mode === 'flat') return [segments.join('_')];
  return segments;
}

/** Join an array of already-sanitized name parts into a C++ qualified name. */
function qualify(parts) {
  return parts.filter((p) => p !== null && p !== undefined && p !== '').join('::');
}

module.exports = {
  CPP_KEYWORDS,
  NAMESPACE_MODES,
  SOURCE_EXTENSIONS,
  namespaceSegmentsForFile,
  qualify,
  sanitizeIdentifier,
  stripSourceExtension,
};
