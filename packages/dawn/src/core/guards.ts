/** Data-only boundaries: never run getters or accept executable/custom objects as domain input. */
export function assertData(value: unknown): void {
  const seen = new Set<object>(); let nodes = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > 50000 || depth > 32) throw new Error("Core data limit exceeded");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || seen.has(item)) throw new Error("Invalid core data");
    const proto = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error("Invalid core data prototype");
    seen.add(item);
    const keys = Reflect.ownKeys(item);
    if (Array.isArray(item) && keys.length !== item.length + 1) throw new Error("Sparse or extended core array");
    for (const key of keys) {
      if (Array.isArray(item) && key === "length") continue;
      if (typeof key !== "string") throw new Error("Invalid core data key");
      if (Array.isArray(item) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) throw new Error("Invalid core array");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("Invalid core data field");
      visit(descriptor.value, depth + 1);
    }
    seen.delete(item);
  }
  try {
    visit(value, 0);
    // Serialize a null-prototype copy so inherited toJSON hooks are never called.
    // Proxies are outside the sandbox contract; ordinary accessors were rejected above.
    const copy = (item: unknown): unknown => {
      if (item === null || typeof item !== "object") return item;
      if (Array.isArray(item)) {
        const array = Object.setPrototypeOf([], null) as unknown[];
        for (let i = 0; i < item.length; i++) array[i] = copy(Object.getOwnPropertyDescriptor(item, String(i))!.value);
        return array;
      }
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of Object.keys(item)) result[key] = copy(Object.getOwnPropertyDescriptor(item, key)!.value);
      return result;
    };
    if (Buffer.byteLength(JSON.stringify(copy(value)), "utf8") > 2 * 1024 * 1024) throw new Error();
  } catch { throw new Error("Invalid or oversized core data"); }
}
export function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid core object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || Object.keys(record).some(key => !fields.includes(key))) throw new Error("Invalid core fields");
  return record;
}
export function text(value: unknown, max = 16000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid core text");
}
export function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("Invalid core identifier");
}
export function unit(value: unknown, min = 0, max = 1): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error("Invalid core range");
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid core integer");
}
export function timestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("Invalid core timestamp");
}
export function list(value: unknown, max = 1000): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("Invalid core list");
}
export function ids(value: unknown, max = 1000): asserts value is string[] {
  list(value, max); value.forEach(id);
  if (new Set(value).size !== value.length) throw new Error("Duplicate core identifier");
}
export function choice<T extends string>(value: unknown, allowed: readonly T[]): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("Invalid core choice");
}
export function clamp(value: number, min = 0, max = 1): number { return Math.min(max, Math.max(min, value)); }
