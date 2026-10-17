'use strict';
/**
 * Public API.
 *
 * `filterFile` is what the Doxygen filter uses: one file in, pseudo-code out.
 * `Session` keeps one `Program` alive across many files and is what
 * pre-generation mode uses.
 */

const path = require('path');
const ts = require('typescript');
const { createProgram, resolveProject } = require('./project');
const { Translator } = require('./translate');

const DEFAULT_OPTIONS = {
  implicitCtors: true,
  virtualMethods: true,
};

/** A translator bound to one Program, reusable for every file in it. */
class Session {
  constructor(program, project, opts = {}) {
    this.program = program;
    this.project = project;
    this.checker = program.getTypeChecker();
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
    this.ctx = {
      program,
      checker: this.checker,
      rootDir: project.rootDir,
      namespaceMode: this.opts.namespaceMode || 'path',
      options: this.opts,
    };
  }

  /** Translate one file that is part of this Program. */
  translate(fileName) {
    const sf = this.program.getSourceFile(fileName)
      || this.program.getSourceFile(path.resolve(fileName))
      || this.program.getSourceFile(ts.sys.resolvePath(fileName));
    if (!sf) {
      throw new Error(`file is not part of the program: ${fileName}`);
    }
    return new Translator(sf, this.ctx).translate();
  }

  /** Every file of the program that we would translate. */
  translatableFiles() {
    return this.program.getSourceFiles()
      .filter((sf) => !sf.isDeclarationFile || !/[\\/]node_modules[\\/]/.test(sf.fileName))
      .filter((sf) => !this.program.isSourceFileDefaultLibrary(sf))
      .filter((sf) => !/[\\/]node_modules[\\/]/.test(sf.fileName))
      .map((sf) => sf.fileName);
  }
}

/**
 * Build a session.
 * @param {string} startPath a file or directory inside the project
 * @param {object} opts `{project, root, namespaceMode, wholeProgram, roots}`
 */
function createSession(startPath, opts = {}) {
  const project = resolveProject(startPath, opts);
  let roots;
  if (opts.roots && opts.roots.length) {
    roots = opts.roots;
  } else if (opts.wholeProgram) {
    roots = project.fileNames.length ? project.fileNames : [startPath];
  } else {
    // Per-file mode: TypeScript pulls in the import closure of this one file,
    // which is everything needed to resolve its types and call targets.
    roots = [path.resolve(startPath)];
  }
  const program = createProgram(roots, project.options);
  return new Session(program, project, opts);
}

/** Translate a single file, building a throw-away Program for it. */
function filterFile(fileName, opts = {}) {
  const session = createSession(fileName, opts);
  return session.translate(path.resolve(fileName));
}

module.exports = { DEFAULT_OPTIONS, Session, createSession, filterFile };
