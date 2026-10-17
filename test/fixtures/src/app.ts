/**
 * Call-graph material: cross-file calls, constructor calls, static calls,
 * `super` calls, calls through typed object members, and calls that cannot be
 * resolved on purpose.
 */

import { AbstractShape, Circle, Rectangle, ShapeBag, Square, type Shape } from './shapes';
import { units } from './types';
import { double, join, parse } from './functions';

/** Builds shapes and reports on them. */
export class Report {
  private bag = new ShapeBag<Shape>();

  /** Fill the bag with a few shapes. */
  populate(): void {
    this.bag.add(new Rectangle(2, 3));
    this.bag.add(new Square(4));
    this.bag.add(new Circle(1));
  }

  /** Total area, converted to millimetres. */
  totalMillimetres(): number {
    const total = this.bag.totalArea();
    return units.toMillimetres(total);
  }

  /** Calls a static method on an imported class. */
  resetCounters(): void {
    AbstractShape.reset();
  }

  /** Calls several free functions, including an overloaded one. */
  summary(): string {
    const value = double(parse('21'));
    return join(' / ', String(value), this.label());
  }

  /** Called by `summary`, so it should show up as a caller edge. */
  label(): string {
    return 'report';
  }

  /** Dynamic dispatch that no type checker can resolve. */
  dynamic(name: string, table: Record<string, () => void>): void {
    table[name]();
  }

  /** Calls through a callback, which the checker still follows. */
  viaCallback(values: number[]): string[] {
    return values.map((value) => this.describeValue(value));
  }

  /** Called only from inside a callback. */
  describeValue(value: number): string {
    return `${value}`;
  }

  /** Calls a function declared inside this one: not a documented entity. */
  withLocalFunction(): number {
    function helper(value: number): number {
      return value + 1;
    }
    return helper(1);
  }

  /** Recursive, so the edge points back at itself. */
  countdown(from: number): number {
    return from <= 0 ? 0 : this.countdown(from - 1);
  }
}

/** A subclass whose constructor calls `super`. */
export class DetailedReport extends Report {
  constructor(private verbose: boolean) {
    super();
    this.populate();
  }

  /** Overrides nothing, but calls an inherited method. */
  describe(): string {
    return this.summary();
  }
}

/** Free function calling into a class and back out to another free function. */
export function run(): string {
  const report = new DetailedReport(true);
  report.populate();
  entryPoint();
  return report.describe();
}

/** Calls a method on an object typed through an interface. */
export function measure(shape: Shape): number {
  return shape.area();
}

/** Deliberately unresolvable: a call on an `any`-typed value. */
export function loose(thing: any): void {
  thing.whatever();
}

function entryPoint(): void {
  const area = measure(new Circle(2));
  console.log(area);
}
