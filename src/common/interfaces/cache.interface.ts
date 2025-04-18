export interface ICacheService {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  increment(key: string): Promise<number>;
  clearAll(): Promise<void>;
  clearByPattern(pattern: string): Promise<void>;
}
