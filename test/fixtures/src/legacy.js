/**
 * Plain JavaScript with JSDoc types, to check the `allowJs` path.
 */

/**
 * A cache of computed values.
 */
export class Cache {
  /**
   * @param {number} capacity maximum number of entries
   */
  constructor(capacity) {
    /** @type {number} */
    this.capacity = capacity;
    /** @type {Object<string, number>} */
    this.entries = {};
  }

  /**
   * Store a value.
   *
   * @param {string} key   entry key
   * @param {number} value entry value
   * @returns {boolean} true when the entry was stored
   */
  put(key, value) {
    if (this.size() >= this.capacity) return false;
    this.entries[key] = value;
    return true;
  }

  /**
   * Number of stored entries.
   * @returns {number} the entry count
   */
  size() {
    return Object.keys(this.entries).length;
  }
}

/**
 * Build a cache of the default size.
 * @returns {Cache} a new cache
 */
export function createCache() {
  return new Cache(16);
}
