/**
 * Generic in-memory collection.
 *
 * Stands in for a database. Insertion order is preserved so list endpoints are
 * deterministic, which matters for a demo. Every method returns deep-ish copies
 * of nothing — callers get the stored reference, so treat records as read-only
 * unless you are the owning service.
 */
export class MemoryCollection<T extends Record<string, unknown>> {
  private readonly items = new Map<string, T>();

  constructor(
    private readonly idField: keyof T & string,
    seed: T[] = [],
  ) {
    for (const item of seed) this.insert(item);
  }

  insert(item: T): T {
    this.items.set(String(item[this.idField]), item);
    return item;
  }

  insertMany(items: T[]): T[] {
    return items.map((i) => this.insert(i));
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  /** Replaces an existing record wholesale. Returns undefined if absent. */
  update(id: string, patch: Partial<T>): T | undefined {
    const existing = this.items.get(id);
    if (!existing) return undefined;
    const next = { ...existing, ...patch } as T;
    this.items.set(id, next);
    return next;
  }

  delete(id: string): boolean {
    return this.items.delete(id);
  }

  all(): T[] {
    return [...this.items.values()];
  }

  find(predicate: (item: T) => boolean): T[] {
    return this.all().filter(predicate);
  }

  findOne(predicate: (item: T) => boolean): T | undefined {
    return this.all().find(predicate);
  }

  count(predicate?: (item: T) => boolean): number {
    return predicate ? this.find(predicate).length : this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  /** Replaces the entire contents — used by `POST /demo/reset`. */
  reset(seed: T[] = []): void {
    this.clear();
    this.insertMany(seed);
  }
}

/** Simple offset pagination helper shared by all list endpoints. */
export function paginate<T>(items: T[], page: number, pageSize: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    pagination: { page, pageSize, total, totalPages },
  };
}
