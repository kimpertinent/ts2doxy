/**
 * Free functions for the `--namespace-mode single` and `none` checks. Every
 * return type ends in an identifier on purpose: in `none` mode that is what
 * Doxygen 1.18 misreads as a class name (`void ::f` becomes `void::f`).
 */

/** A stored session. */
export class Session {
  constructor(public id: string, public hits: number) {}
}

const store = new Map<string, Session>();

/** Look a session up. */
export function findSession(id: string): Session | undefined {
  return store.get(id);
}

/** Insert or update a session. */
export function upsertSession(id: string): void {
  const existing = findSession(id);
  if (existing) {
    existing.hits = countHits(existing) + 1;
  } else {
    store.set(id, new Session(id, 1));
  }
}

/** Hit count of a session. */
export function countHits(session: Session): number {
  return session.hits;
}

/** Whether a session exists. */
export const hasSession = (id: string): boolean => findSession(id) !== undefined;

/** Insert several sessions. */
export async function upsertAll(ids: string[]): Promise<void> {
  for (const id of ids) upsertSession(id);
}
