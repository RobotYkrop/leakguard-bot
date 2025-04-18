import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { AppError } from 'src/common/errors/app.error';
import { IBreachChecker } from 'src/common/interfaces/breach-checker.interface';
import { Breach, PasswordCheckResult } from '../types/breach.types';
import { RedisCacheService } from 'src/modules/cache/redis/redis-cache.service';

@Injectable()
export class LeakCheckApiService implements IBreachChecker {
  private readonly logger = new Logger(LeakCheckApiService.name);
  private readonly apiUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly cacheService: RedisCacheService,
  ) {
    this.apiUrl = this.configService.getOrThrow<string>('app.leakCheckApiUrl');
  }

  async checkEmailBreaches(email: string): Promise<Breach[]> {
    const cacheKey = `leakcheck:${email}`;
    const cached = await this.cacheService.get<Breach[]>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<{
          success: boolean;
          sources: { name: string; date?: string }[];
        }>(`${this.apiUrl}?key=YOUR_KEY&check=${encodeURIComponent(email)}`, {
          headers: {
            'User-Agent': 'LeakGuardBot/1.0',
            Accept: 'application/json',
          },
        }),
      );

      if (!response.data.success) {
        this.logger.warn(`LeakCheck failed for ${email}`);
        return [];
      }

      const breaches: Breach[] = response.data.sources.map((source) => ({
        Name: source.name,
        Domain: undefined,
        BreachDate: source.date,
      }));

      await this.cacheService.set(cacheKey, breaches, 24 * 60 * 60);
      return breaches;
    } catch (error) {
      this.logger.warn(
        `LeakCheck error for ${email}: ${(error as Error).message}`,
      );
      throw new AppError(
        `LeakCheck API error: ${(error as Error).message}`,
        500,
        'LEAKCHECK_ERROR',
      );
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async checkPassword(password: string): Promise<PasswordCheckResult> {
    // LeakCheck API не поддерживает проверку паролей, возвращаем пустой результат
    return {
      found: false,
      count: 0,
      digits: 0,
      alphabets: 0,
      specialChars: 0,
      length: 0,
    };
  }
}
