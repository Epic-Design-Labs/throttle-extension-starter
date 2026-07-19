export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes?: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
}

export const requireText = (value: string, name: string): string => {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  return value;
};
