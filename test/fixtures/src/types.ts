/**
 * Type-level constructs: enums, type aliases, unions, intersections, mapped,
 * conditional and literal types, tuples, function types and generics with
 * constraints and defaults.
 */

/** Direction of travel. */
export enum Direction {
  /** Towards decreasing x. */
  Left = -1,
  /** No movement. */
  None = 0,
  /** Towards increasing x. */
  Right = 1,
}

/** String-valued enum. */
export const enum Mode {
  Fast = 'fast',
  Slow = 'slow',
}

/** A plain alias. */
export type Pixels = number;

/** A union of primitives. */
export type Scalar = string | number | boolean;

/** A nullable reference. */
export type MaybeName = string | null;

/** A union of string literals. */
export type Alignment = 'start' | 'center' | 'end';

/** An intersection. */
export type Identified = { id: string } & { revision: number };

/** A tuple. */
export type Point = [x: number, y: number];

/** A function type. */
export type Comparator<T> = (left: T, right: T) => number;

/** A mapped type. */
export type Flags<T> = { [K in keyof T]: boolean };

/** A conditional type. */
export type Unwrap<T> = T extends Promise<infer U> ? U : T;

/** A generic alias with a constraint and a default. */
export type Table<Row extends object = Record<string, Scalar>> = Row[];

/** An indexed access type. */
export type FirstPoint = Point[0];

/** A `keyof` type. */
export type IdentifiedKey = keyof Identified;

/** A template literal type. */
export type EventName = `on${Capitalize<string>}`;

/** Interface with an index signature and a call signature. */
export interface Lookup<V> {
  /** Any string key maps to a value. */
  [key: string]: V;
}

/** Interface that is itself callable and constructible. */
export interface Factory<T> {
  /** Call signature. */
  (count: number): T[];
  /** Construct signature. */
  new (count: number): T[];
  /** Ordinary method. */
  describe(): string;
}

/** Interface inheritance, including multiple bases. */
export interface Named {
  name: string;
}

/** Combines two base interfaces. */
export interface NamedAndIdentified extends Named, Identified {
  /** Optional member. */
  nickname?: string;
}

/** A TypeScript namespace, which becomes a nested C++ namespace. */
export namespace units {
  /** Millimetres per inch. */
  export const MM_PER_INCH: number = 25.4;

  /** Convert inches to millimetres. */
  export function toMillimetres(inches: number): number {
    return inches * MM_PER_INCH;
  }

  /** Nested one level deeper. */
  export namespace imperial {
    /** Inches per foot. */
    export const INCHES_PER_FOOT = 12;
  }
}
