/**
 * Overload sets. TypeScript writes them as several body-less signatures
 * followed by one implementation; only the signatures are callable, and none
 * of them is abstract.
 */

/** Formats values of several types. */
export class Formatter {
  /** Format a number. */
  format(value: number): string;
  /** Format a date. */
  format(value: boolean): string;
  format(value: number | boolean): string {
    return String(value);
  }

  /** An ordinary method, for contrast. */
  trim(value: string): string {
    return value.trim();
  }
}

/** Constructor overloads: the parameter properties live on the implementation. */
export class Span {
  /** From an end bound only. */
  constructor(end: number);
  /** From both bounds. */
  constructor(start: number, end: number);
  constructor(public start: number, public end: number = 0) {}

  /** Width of the span. */
  width(): number {
    return this.end - this.start;
  }
}

/** An ambient class: its methods have no body but are not abstract either. */
export declare class Native {
  /** Implemented outside TypeScript. */
  invoke(value: string): number;
}
