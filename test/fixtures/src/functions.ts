/**
 * Functions: declarations, overloads, arrow functions assigned to `const`,
 * generics, default and rest parameters, destructured parameters, async and
 * generator functions, and named / default exports.
 */

import { Alignment, Comparator, Scalar } from './types';

/** Overload: parse a number. */
export function parse(input: number): number;
/** Overload: parse a string. */
export function parse(input: string): number;
/** Implementation. */
export function parse(input: string | number): number {
  return typeof input === 'number' ? input : Number.parseFloat(input);
}

/** A generic identity function. */
export function identity<T>(value: T): T {
  return value;
}

/** Constrained generic with a default. */
export function firstOr<T extends Scalar = string>(values: T[], fallback: T): T {
  return values.length ? values[0] : fallback;
}

/** Default and rest parameters. */
export function join(separator: string = ', ', ...parts: string[]): string {
  return parts.join(separator);
}

/** Destructured parameter. */
export function place({ align, offset }: { align: Alignment; offset: number }): string {
  return `${align}+${offset}`;
}

/** An arrow function assigned to a const. */
export const double = (value: number): number => value * 2;

/** An async arrow function. */
export const fetchName = async (id: string): Promise<string> => `name-${id}`;

/** A generator. */
export function* counter(limit: number): Generator<number> {
  for (let i = 0; i < limit; i++) yield i;
}

/** A plain async function. */
export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Takes a callback typed through an alias. */
export function sortWith<T>(values: T[], compare: Comparator<T>): T[] {
  return [...values].sort(compare);
}

/** A module-level constant. */
export const VERSION = '1.0.0';

/** Not exported at the declaration, exported further down. */
function internalHelper(value: number): number {
  return double(value);
}

/** The default export of this module. */
export default function describe(): string {
  return `functions v${VERSION}`;
}

export { internalHelper as helper };
