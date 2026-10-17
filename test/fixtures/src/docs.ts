/**
 * JSDoc / TSDoc conversion fixture.
 *
 * Covers every tag the task lists plus the inline link forms, including the
 * ones that must *not* turn into a Doxygen reference.
 *
 * @module docs
 */

import { Circle } from './shapes';

/**
 * Normalizes a label.
 *
 * A longer description with `inline code`, a list:
 *
 * - one
 * - two
 *
 * a resolvable link to {@link Circle}, a labelled one to
 * {@link Circle.area | the area method}, a member link {@link betterNormalize},
 * an unresolvable {@link NotAThingAnywhere} and a URL
 * {@link https://example.com/docs}.
 *
 * @param input the raw label
 * @param maximum maximum length
 * @returns the normalized label
 * @throws {RangeError} when `maximum` is negative
 * @deprecated use {@link betterNormalize} instead
 * @since 0.2.0
 * @example
 * ```ts
 * normalize('  Hello  '); // 'Hello'
 * ```
 */
export function normalize(input: string, maximum?: number): string {
  return input.trim().slice(0, maximum ?? 80);
}

/**
 * The replacement for {@link normalize}.
 *
 * @param input the raw label
 * @returns the normalized label
 */
export function betterNormalize(input: string): string {
  return input.trim();
}

/**
 * Picks the first element.
 *
 * @typeParam T the element type
 * @param values the values to pick from
 * @returns the first value, if there is one
 */
export function headOf<T>(values: T[]): T | undefined {
  return values[0];
}

/**
 * Does something and returns nothing.
 *
 * @param value ignored
 * @returns nothing at all
 */
export function sideEffect(value: string): void {
  void value;
}

/**
 * Destructured parameters are documented with dotted names that cannot be
 * matched against the emitted signature.
 *
 * @param options the options
 * @param options.width the width
 * @param options.height the height
 * @returns the area
 */
export function rectangleArea({ width, height }: { width: number; height: number }): number {
  return width * height;
}

/**
 * An example without a fenced code block.
 *
 * @example
 * const c = describeCircle(new Circle(1));
 * console.log(c);
 */
export function describeCircle(circle: Circle): string {
  return `circle of area ${circle.area()}`;
}

/**
 * A tuning constant.
 *
 * @remarks
 * Changing this affects every caller.
 *
 * @defaultValue 42
 * @internal
 */
export const TUNING = 42;

/**
 * Carries a tag Doxygen does not know.
 *
 * @customTag with a value
 * @group Utilities
 */
export class Documented {
  /**
   * Counts things.
   *
   * @param step how much to add each time
   * @returns the new count
   */
  increment(step: number = 1): number {
    return step;
  }

  /**
   * Text with characters that are special to Doxygen: a@b, 100%, C#,
   * `Array<T>` in code and Array<T> in prose, a \backslash and a #hash.
   */
  escaping(): void {}
}
