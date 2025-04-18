import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '../../../common/errors/app.error';
import { IBreachChecker } from '../../../common/interfaces/breach-checker.interface';
import { PuppeteerService } from '../../puppeteer/puppeteer.service';
import { RedisCacheService } from '../../cache/redis/redis-cache.service';
import { keccak512 } from 'js-sha3';
import {
  BreachDetails,
  Breach,
  PasswordCheckResult,
  Analytics,
} from '../types/breach.types';
import pTimeout from 'p-timeout';

interface XposedOrNotCheckResponse {
  breaches?: [string[]];
}

interface XposedOrNotAnalyticsResponse {
  BreachesSummary?: { site?: string };
  ExposedBreaches?: { breaches_details: BreachDetails[] };
  BreachMetrics?: {
    industry?: [[string, number][]];
    passwords_strength?: [
      { PlainText: number; StrongHash: number; Unknown: number },
    ];
    risk?: [{ risk_label: string; risk_score: number }];
    xposed_data?: [
      {
        children: {
          name: string;
          children: { name: string; value: number }[];
        }[];
      },
    ];
    yearwise_details?: [{ [year: string]: number }];
  };
}

interface PasswordCheckResponse {
  Error?: string;
  SearchPassAnon?: {
    char: string;
    count: string;
  };
}

@Injectable()
export class XposedOrNotApiService implements IBreachChecker {
  private readonly logger = new Logger(XposedOrNotApiService.name);
  private readonly apiUrl: string;
  private readonly TIMEOUT_MS = 30000; // 30 секунд

  constructor(
    private readonly configService: ConfigService,
    private readonly puppeteerService: PuppeteerService,
    private readonly cacheService: RedisCacheService,
  ) {
    this.apiUrl = this.configService.getOrThrow<string>(
      'app.xposedOrNotApiUrl',
    );
    this.logger.log('XposedOrNotApiService initialized');
  }

  async checkEmailBreaches(email: string): Promise<Breach[]> {
    const cacheKey = `xposed:${email}`;
    const cached = await this.cacheService.get<Breach[]>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    try {
      const url = `${this.apiUrl}/check-email/${encodeURIComponent(email)}?include_details=false`;
      this.logger.debug(`Fetching breaches from ${url}`);
      const promise =
        this.puppeteerService.scrapeJSON<XposedOrNotCheckResponse>(url);
      const result = await pTimeout(promise, this.TIMEOUT_MS);

      const breaches: Breach[] = (result.breaches?.[0] || []).map(
        (name: string) => ({
          Name: name,
          Domain: undefined,
          BreachDate: undefined,
        }),
      );

      await this.cacheService.set(cacheKey, breaches, 24 * 60 * 60);
      this.logger.log(`Stored ${breaches.length} breaches for ${email}`);
      return breaches;
    } catch (error) {
      this.logger.error(
        `XposedOrNot failed for ${email}: ${(error as Error).message}`,
      );
      throw new AppError(
        `XposedOrNot API error: ${(error as Error).message}`,
        500,
        'XPOSED_OR_NOT_ERROR',
      );
    }
  }

  async checkPassword(password: string): Promise<PasswordCheckResult> {
    if (!password) {
      this.logger.warn('Empty password provided');
      return this.computePasswordStats('');
    }

    const hash = keccak512(password);
    const cacheKey = `password:${hash}`;
    const cached = await this.cacheService.get<PasswordCheckResult>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    const hashPrefix = hash.slice(0, 10);
    const url = `https://passwords.xposedornot.com/api/v1/pass/anon/${hashPrefix}`;

    try {
      this.logger.debug(`Fetching password check from ${url}`);
      const promise =
        this.puppeteerService.scrapeJSON<PasswordCheckResponse>(url);
      const result = await pTimeout(promise, this.TIMEOUT_MS);

      if (result.Error === 'Not found') {
        const computed = this.computePasswordStats(password);
        await this.cacheService.set(cacheKey, computed, 24 * 60 * 60);
        return computed;
      }

      const { SearchPassAnon } = result;
      if (!SearchPassAnon) {
        this.logger.warn(
          `Invalid password check response: ${JSON.stringify(result)}`,
        );
        const computed = this.computePasswordStats(password);
        await this.cacheService.set(cacheKey, computed, 24 * 60 * 60);
        return computed;
      }

      const charMatch = SearchPassAnon.char.match(
        /D:(\d+);A:(\d+);S:(\d+);L:(\d+)/,
      );
      const [_, digits, alphabets, specialChars, length] = charMatch
        ? charMatch.map(Number)
        : [null, 0, 0, 0, 0];

      const finalResult: PasswordCheckResult = {
        found: true,
        count: parseInt(SearchPassAnon.count, 10) || 0,
        digits,
        alphabets,
        specialChars,
        length,
      };

      await this.cacheService.set(cacheKey, finalResult, 24 * 60 * 60);
      return finalResult;
    } catch (error) {
      this.logger.error(`Password check failed: ${(error as Error).message}`);
      const computed = this.computePasswordStats(password);
      await this.cacheService.set(cacheKey, computed, 24 * 60 * 60);
      return computed;
    }
  }

  async getAnalytics(email: string): Promise<Analytics> {
    const cacheKey = `xposed_analytics:${email}`;
    const cached = await this.cacheService.get<Analytics>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    try {
      const url = `${this.apiUrl}/breach-analytics?email=${encodeURIComponent(email)}`;
      this.logger.debug(`Fetching analytics from ${url}`);
      const promise =
        this.puppeteerService.scrapeJSON<XposedOrNotAnalyticsResponse>(url);
      const result = await pTimeout(promise, this.TIMEOUT_MS);

      const summary =
        result.BreachesSummary?.site?.split(';').filter(Boolean) || [];
      const breachesDetails = result.ExposedBreaches?.breaches_details || [];
      const metrics = result.BreachMetrics;

      const industries =
        metrics?.industry?.[0]
          ?.filter(([, count]: [string, number]) => count > 0)
          .map(([name, count]: [string, number]) => ({ name, count })) || [];

      const passwordStrength = metrics?.passwords_strength?.[0] || {
        PlainText: 0,
        StrongHash: 0,
        Unknown: 0,
      };

      const risk = metrics?.risk?.[0] || {
        risk_label: 'Unknown',
        risk_score: 0,
      };

      const exposedData =
        metrics?.xposed_data?.[0]?.children?.map((category) => ({
          category: category.name,
          items: category.children.map((item) => ({
            name: item.name,
            value: item.value,
          })),
        })) || [];

      const years = metrics?.yearwise_details?.[0]
        ? Object.entries(metrics.yearwise_details[0])
            .filter(([, count]) => typeof count === 'number' && count > 0)
            .map(([year, count]) => ({
              year: year.slice(1),
              count: count,
            }))
        : [];

      const analytics: Analytics = {
        breaches: summary,
        breachesDetails,
        industries,
        passwordStrength,
        risk: { label: risk.risk_label, score: risk.risk_score },
        exposedData,
        years,
      };

      await this.cacheService.set(cacheKey, analytics, 7 * 24 * 60 * 60);
      this.logger.log(`Stored analytics for ${email}`);
      return analytics;
    } catch (error) {
      this.logger.error(
        `XposedOrNot analytics failed for ${email}: ${(error as Error).message}`,
      );
      return {
        breaches: [],
        breachesDetails: [],
        industries: [],
        passwordStrength: { PlainText: 0, StrongHash: 0, Unknown: 0 },
        risk: { label: 'Unknown', score: 0 },
        exposedData: [],
        years: [],
      };
    }
  }

  private computePasswordStats(password: string): PasswordCheckResult {
    return {
      found: false,
      count: 0,
      digits: (password.match(/\d/g) || []).length,
      alphabets: (password.match(/[a-zA-Z]/g) || []).length,
      specialChars: (password.match(/[^a-zA-Z0-9]/g) || []).length,
      length: password.length,
    };
  }
}
