'use strict';
/**
 * tsconfig discovery and TypeScript `Program` construction.
 *
 * The filter needs a type checker, not just a parse tree: call targets,
 * base classes and imported types can only be resolved through it. Building a
 * checker means building a `Program`, which is the expensive part of a run --
 * see `docs`/README for the measured numbers and the two strategies below.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { findConfigFile, findUp, locateConfigFile, startDirectory } = require('./findup');
const { sanitizeIdentifier } = require('./names');

/** Compiler options that are forced regardless of what the tsconfig says. */
const FORCED_OPTIONS = {
  noEmit: true,
  declaration: false,
  declarationMap: false,
  sourceMap: false,
  inlineSourceMap: false,
  incremental: false,
  composite: false,
  tsBuildInfoFile: undefined,
  outDir: undefined,
  outFile: undefined,
  skipLibCheck: true,
  skipDefaultLibCheck: true,
  allowJs: true,
  // Never fail on project-level errors; we only read the AST and the checker.
  noEmitOnError: false,
};

/** Options used when no tsconfig.json can be found (plain JS projects). */
function fallbackOptions() {
  return {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowJs: true,
    checkJs: true,
    resolveJsonModule: true,
    strict: false,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    ...FORCED_OPTIONS,
  };
}

/**
 * Resolve the project context for a file or directory: which tsconfig applies,
 * which compiler options to use and which directory namespaces are relative to.
 */
function resolveProject(startPath, opts = {}) {
  const startDir = startDirectory(startPath);
  let configPath = locateConfigFile(startPath, opts.project);

  let options;
  let fileNames = [];
  let configFiles = [];
  let wildcardDirectories = {};
  let configDir = startDir;
  const diagnostics = [];

  if (configPath && fs.existsSync(configPath)) {
    configDir = path.dirname(configPath);
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      /* optionsToExtend */ {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (d) => diagnostics.push(d),
      },
    );
    if (parsed) {
      options = { ...parsed.options, ...FORCED_OPTIONS };
      fileNames = parsed.fileNames;
      // Every config file the options came from, `extends` chain included,
      // and the directories `include` globs over: what the filter-mode cache
      // has to watch to notice a changed configuration or file list.
      configFiles = [path.resolve(configPath),
        ...((parsed.options.configFile && parsed.options.configFile.extendedSourceFiles) || [])];
      wildcardDirectories = parsed.wildcardDirectories || {};
      for (const d of parsed.errors || []) diagnostics.push(d);
    }
  }
  if (!options) {
    configPath = null;
    options = fallbackOptions();
    // Without a tsconfig, fall back to the package root so that every file of
    // the same project still agrees on the namespace prefix.
    const pkg = findUp(startDir, ['package.json']);
    if (pkg) configDir = path.dirname(pkg);
  }
  if (options.jsx === undefined) options.jsx = ts.JsxEmit.Preserve;

  // Namespaces are derived from the path relative to this directory, so every
  // invocation of the filter must compute the same value for it.
  const rootDir = path.resolve(
    opts.root || options.rootDir || configDir,
  );

  return {
    configPath, configDir, configFiles, options, fileNames, rootDir, wildcardDirectories, diagnostics,
  };
}

/**
 * The namespace `--namespace-mode single` puts everything into: the `name` of
 * the package.json next to the project's tsconfig (a scoped `@scope/pkg`
 * becomes `scope_pkg`), else the name of the tsconfig's directory. Only that
 * one directory is looked at, so a package.json further up -- a monorepo root,
 * an unrelated parent -- cannot name the project.
 */
function defaultNamespaceName(project) {
  const pkgPath = path.join(project.configDir, 'package.json');
  let name = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (typeof pkg.name === 'string' && pkg.name.trim()) name = pkg.name.trim();
  } catch {
    // no package.json, or not valid JSON: fall back to the directory name
  }
  if (!name) name = path.basename(path.resolve(project.configDir));
  return sanitizeIdentifier(name.replace(/^@/, ''), 'project');
}

/**
 * Build a Program.
 *
 * `roots` decides the strategy:
 *   - a single input file: TypeScript pulls in its import closure, which is all
 *     that is needed to resolve its base classes and call targets. This is the
 *     fast path used by the per-file filter mode.
 *   - the full tsconfig file list: used by pre-generation mode, where one
 *     Program serves every file.
 */
function createProgram(roots, options, host) {
  return ts.createProgram({
    rootNames: roots,
    options,
    host: host || ts.createCompilerHost(options, /* setParentNodes */ true),
  });
}

module.exports = {
  FORCED_OPTIONS,
  createProgram,
  defaultNamespaceName,
  fallbackOptions,
  findConfigFile,
  findUp,
  resolveProject,
};
