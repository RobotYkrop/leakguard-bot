import { Inject, Injectable, Logger } from '@nestjs/common';
import { ICacheService } from '../../common/interfaces/cache.interface';
import { AppError } from '../../common/errors/app.error';

@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(@Inject('ICacheService') private readonly cache: ICacheService) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      return await this.cache.get<T>(key);
    } catch (error) {
      this.logger.warn(
        `Cache get failed for key ${key}: ${(error as Error).message}`,
      );
      throw new AppError(`Cache operation failed`, 500, 'CACHE_ERROR');
    }
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      await this.cache.set(key, value, ttl);
    } catch (error) {
      this.logger.warn(
        `Cache set failed for key ${key}: ${(error as Error).message}`,
      );
      throw new AppError(`Cache operation failed`, 500, 'CACHE_ERROR');
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.cache.del(key);
    } catch (error) {
      this.logger.warn(
        `Cache del failed for key ${key}: ${(error as Error).message}`,
      );
      throw new AppError(`Cache operation failed`, 500, 'CACHE_ERROR');
    }
  }

  async increment(key: string): Promise<number> {
    try {
      return await this.cache.increment(key);
    } catch (error) {
      this.logger.warn(
        `Cache increment failed for key ${key}: ${(error as Error).message}`,
      );
      throw new AppError(`Cache operation failed`, 500, 'CACHE_ERROR');
    }
  }

  async clearAll(): Promise<void> {
    try {
      await this.cache.clearAll();
      this.logger.log('Cache cleared');
    } catch (error) {
      this.logger.error(`Failed to clear cache: ${(error as Error).message}`);
      throw new AppError(`Cache operation failed`, 500, 'CACHE_ERROR');
    }
  }

  async clearByPattern(pattern: string): Promise<void> {
    try {
      await this.cache.clearByPattern(pattern);
      this.logger.log(`Cleared cache for pattern ${pattern}`);
    } catch (error) {
      this.logger.error(
        `Failed to clear cache by pattern ${pattern}: ${(error as Error).message}`,
      );
      throw new AppError(`Cache operation failed`, 500, 'CACHE_ERROR');
    }
  }
}
