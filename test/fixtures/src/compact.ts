/**
 * Compact formatting: several declarations on one source line.
 *
 * Doxygen 1.9.8 invents call references when declarations share a line, so
 * the filter has to keep each declaration on its own output line even though
 * that costs the exact line number of all but the first.
 */

/** An interface written on a single line. */
export interface Part { start(): void; stop(): void; label(): string; }

/** A class written on a single line. */
export class Tiny { value = 1; name(): string { return 'tiny'; } }

/** Two members sharing a line inside a normal class. */
export class Mixed {
  first = 1; second = 2;
  begin(): void { this.end(); } end(): void { /* nothing */ }
}

/** Uses the compact declarations, so there are real edges to compare against. */
export function usePart(part: Part): string {
  part.start();
  part.stop();
  return part.label();
}
