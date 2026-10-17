/**
 * Declarations without type annotations, where the emitted type has to come
 * from the type checker. Type arguments and qualified names must survive.
 */

import { Circle } from './shapes';
import { Direction } from './types';

/** Keeps things in indexed collections, all of them inferred. */
export class Store {
  /** Inferred as `Map<string, number>`. */
  private index = new Map<string, number>();

  /** Inferred as `Set<Promise<string>>`. */
  private pending = new Set<Promise<string>>();

  /** Inferred as `Map<string, Circle>` -- a type from another module. */
  shapes = new Map<string, Circle>();

  /** Inferred as `string[]`. */
  readonly tags = ['a', 'b'];

  /** Inferred as `Direction`. */
  heading = Direction.Right;

  /** Inferred return type `number | undefined`. */
  lookup(key: string) {
    return this.index.get(key);
  }

  /** Inferred return type `Map<string, Circle>`. */
  allShapes() {
    return this.shapes;
  }
}

/** Inferred as `Map<string, Store>`. */
export const registry = new Map<string, Store>();

/** Inferred return type, a locally declared class. */
export function makeStore() {
  return new Store();
}
