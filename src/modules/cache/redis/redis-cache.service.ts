import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';
import { ICacheService } from 'src/common/interfaces/cache.interface';

@Injectable()
export class RedisCacheService
  implements ICacheService, OnModuleInit, OnModuleDestroy
{
  private readonly client: Redis;
  private readonly logger = new Logger(RedisCacheService.name);
  private isConnected = false;

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

    this.client = new Redis(redisConfig);
    this.setupEventListeners();
  }

  private setupEventListeners(): void {
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

  private checkConnection(): void {
    if (!this.isConnected) {
      this.logger.warn('Redis is not connected. Operation may fail.');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    this.checkConnection();
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    this.checkConnection();
    const stringValue = JSON.stringify(value);
    if (ttl) {
      await this.client.set(key, stringValue, 'EX', ttl);
    } else {
      await this.client.set(key, stringValue);
    }
  }

  async del(key: string): Promise<void> {
    this.checkConnection();
    await this.client.del(key);
  }

  async increment(key: string): Promise<number> {
    this.checkConnection();
    const newValue = await this.client.incr(key);
    this.logger.debug(`Incremented key ${key} to value ${newValue}`);
    return newValue;
  }

  async clearAll(): Promise<void> {
    this.checkConnection();
    await this.client.flushdb();
  }

  async clearByPattern(pattern: string): Promise<void> {
    this.checkConnection();
    const keys = await this.client.keys(pattern);
    if (keys.length === 0) {
      this.logger.log(`No keys found for pattern ${pattern}`);
      return;
    }
    await this.client.del(...keys);
    this.logger.log(`Cleared ${keys.length} keys matching pattern ${pattern}`);
  }
}
