'use strict';
/**
 * tsconfig discovery by walking up the directory tree.
 *
 * Kept apart from `project.js` because it must not load `typescript`: the
 * filter-mode cache (`cache.js`) uses it to find its cache entry, and a cache
 * hit is supposed to cost no more than starting node.
 */

const fs = require('fs');
const path = require('path');

/** Walk up from `startDir` looking for the nearest directory holding `name`. */
function findUp(startDir, names) {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Walk up from `startDir` looking for the nearest tsconfig.json / jsconfig.json. */
function findConfigFile(startDir) {
  return findUp(startDir, ['tsconfig.json', 'jsconfig.json']);
}

/** The directory a search starts from: `startPath` itself, or its parent. */
function startDirectory(startPath) {
  return fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(path.resolve(startPath));
}

/**
 * The tsconfig that applies to `startPath`: `project` (`--project`, a file or a
 * directory holding a tsconfig.json) when given, else the nearest one upwards.
 * May name a file that does not exist; null when the search finds nothing.
 */
function locateConfigFile(startPath, project) {
  let configPath = project ? path.resolve(project) : findConfigFile(startDirectory(startPath));
  if (configPath && fs.existsSync(configPath) && fs.statSync(configPath).isDirectory()) {
    configPath = path.join(configPath, 'tsconfig.json');
  }
  return configPath;
}

module.exports = { findConfigFile, findUp, locateConfigFile, startDirectory };
