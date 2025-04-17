import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly client: Redis;
  private readonly logger = new Logger(RedisService.name);
  private isConnected = false; // Флаг для отслеживания состояния подключения

  constructor(private readonly configService: ConfigService) {
    const redisConfig: RedisOptions = {
      host: this.configService.get<string>('REDIS_HOST', 'localhost'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD', ''),
      tls:
        this.configService.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
    };

    this.logger.log(
      `Connecting to Redis at ${redisConfig.host}:${redisConfig.port}`,
    );

    this.client = new Redis(redisConfig);

    this.client.on('error', (err) => {
      this.logger.warn(`Redis error: ${err.message}`);
      this.isConnected = false;
    });
    this.client.on('connect', () => {
      this.logger.log('Connected to Redis');
      this.isConnected = true;
    });
    this.client.on('ready', () => {
      this.logger.log('Redis is ready');
      this.isConnected = true;
    });
    this.client.on('close', () => {
      this.logger.warn('Redis connection closed');
      this.isConnected = false;
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.ping();
      this.logger.log('Redis ping successful');
    } catch (err) {
      this.logger.error(`Redis ping failed: ${(err as Error).message}`);
      // Не бросаем ошибку, чтобы приложение продолжило работу
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
      this.logger.log('Redis connection closed');
    } catch (err) {
      this.logger.warn(
        `Failed to close Redis connection: ${(err as Error).message}`,
      );
    }
  }

  // Проверка состояния подключения
  private checkConnection(): void {
    if (!this.isConnected) {
      this.logger.warn('Redis is not connected. Operation may fail.');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    this.checkConnection();
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
    this.checkConnection();
    try {
      await this.client.set(key, JSON.stringify(value), 'EX', ttl);
    } catch (error) {
      this.logger.warn(
        `Redis set failed for key ${key}: ${(error as Error).message}`,
      );
    }
  }

  async del(key: string): Promise<void> {
    this.checkConnection();
    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.warn(
        `Redis del failed for key ${key}: ${(error as Error).message}`,
      );
    }
  }

  async increment(key: string): Promise<number> {
    this.checkConnection();
    try {
      const newValue = await this.client.incr(key);
      this.logger.debug(`Incremented key ${key} to value ${newValue}`);
      return newValue;
    } catch (error) {
      this.logger.warn(
        `Redis increment failed for key ${key}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async clearCache(): Promise<void> {
    this.checkConnection();
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

  async clearCacheByPattern(pattern: string): Promise<void> {
    this.checkConnection();
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
