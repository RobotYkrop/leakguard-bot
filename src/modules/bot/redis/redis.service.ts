// src/modules/redis/redis.service.ts
import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService {
  private readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT as string, 10) || 6379,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
    });
    this.client.on('error', (err) =>
      this.logger.warn(`Redis error: ${err.message}`),
    );
    this.client.on('connect', () => this.logger.log('Connected to Redis'));
    this.client.on('ready', () => this.logger.log('Redis is ready'));
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      this.logger.warn(
        `Redis get failed for key ${key}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async set<T>(key: string, value: T, ttl: number): Promise<void> {
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      this.logger.warn(
        `Redis set failed for key ${key}: ${(error as Error).message}`,
      );
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.warn(
        `Redis del failed for key ${key}: ${(error as Error).message}`,
      );
    }
  }

  // Новый метод: Увеличение значения ключа на 1
  async increment(key: string): Promise<number> {
    try {
      const newValue = await this.client.incr(key);
      this.logger.debug(`Incremented key ${key} to value ${newValue}`);
      return newValue;
    } catch (error) {
      this.logger.warn(
        `Redis increment failed for key ${key}: ${(error as Error).message}`,
      );
      throw error; // Бросаем ошибку, чтобы вызывающий код мог обработать её
    }
  }

  // Новый метод: Очистка всех ключей в текущей базе данных
  async clearCache(): Promise<void> {
    try {
      await this.client.flushdb();
      this.logger.log('Redis cache cleared (FLUSHDB)');
    } catch (error) {
      this.logger.error(
        `Failed to clear Redis cache: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  // Новый метод: Очистка ключей по шаблону
  async clearCacheByPattern(pattern: string): Promise<void> {
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length === 0) {
        this.logger.log(`No keys found for pattern ${pattern}`);
        return;
      }
      await this.client.del(...keys);
      this.logger.log(
        `Cleared ${keys.length} keys matching pattern ${pattern}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to clear keys by pattern ${pattern}: ${(error as Error).message}`,
      );
      throw error;
    }
  }
}
