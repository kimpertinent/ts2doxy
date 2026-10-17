/**
 * Geometric primitives.
 *
 * Covers: interfaces, abstract classes, `extends`, `implements`, access
 * modifiers, `static`, `readonly`, getters/setters, parameter properties and
 * generic classes.
 *
 * @module shapes
 */

/** Anything that encloses an area. */
export interface Shape {
  /** Area in square units. */
  area(): number;
  /** Human readable name. */
  readonly name: string;
  /** Scale the shape in place. */
  scale(factor: number): void;
}

/** Anything that can be drawn on a canvas. */
export interface Drawable {
  draw(target: string): void;
}

/** Base class for all shapes. */
export abstract class AbstractShape implements Shape {
  /** Number of shapes ever constructed. */
  static instances: number = 0;

  /** Identity of this shape, assigned at construction time. */
  readonly id: string;

  /** Internal scale factor. */
  protected factor: number = 1;

  /** Truly private, enforced by the runtime. */
  #secret: number = 42;

  constructor(readonly name: string, id?: string) {
    this.id = id ?? 'anonymous';
    AbstractShape.instances += 1;
  }

  /** Subclasses must say how large they are. */
  abstract area(): number;

  /** Scale by `factor`. */
  scale(factor: number): void {
    this.factor = factor;
  }

  /** Current scale factor. */
  get currentScale(): number {
    return this.factor;
  }

  /** Replace the scale factor. */
  set currentScale(value: number) {
    this.factor = value;
  }

  /** Reset the global instance counter. */
  static reset(): void {
    AbstractShape.instances = 0;
  }

  private audit(): number {
    return this.#secret;
  }
}

/** An axis-aligned rectangle. */
export class Rectangle extends AbstractShape implements Drawable {
  constructor(public width: number, public height: number) {
    super('rectangle');
  }

  area(): number {
    return this.width * this.height;
  }

  draw(target: string): void {
    log(`${target}: ${this.name}`);
  }
}

/** A square is a rectangle with equal sides. */
export class Square extends Rectangle {
  constructor(side: number) {
    super(side, side);
  }
}

/** A circle. */
export class Circle extends AbstractShape {
  /** Mathematical constant, kept local on purpose. */
  static readonly PI: number = 3.141592653589793;

  constructor(private radius: number) {
    super('circle');
  }

  area(): number {
    return Circle.PI * this.radius * this.radius;
  }
}

/** A typed, generic container of shapes. */
export class ShapeBag<T extends Shape> {
  private items: T[] = [];

  /** Add one item. */
  add(item: T): void {
    this.items.push(item);
  }

  /** Total area of every item in the bag. */
  totalArea(): number {
    let sum = 0;
    for (const item of this.items) {
      sum += item.area();
    }
    return sum;
  }
}

function log(message: string): void {
  console.log(message);
}
