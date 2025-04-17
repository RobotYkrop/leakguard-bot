import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { keccak512 } from 'js-sha3';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { RedisService } from '../bot/redis/redis.service';
import { BotService } from '../bot/bot.service';

interface Breach {
  Name: string;
  Domain?: string;
  BreachDate?: string;
}

interface Analytics {
  breaches: string[];
  breachesDetails: BreachDetails[];
  industries: { name: string; count: number }[];
  passwordStrength: { PlainText: number; StrongHash: number; Unknown: number };
  risk: { label: string; score: number };
  exposedData: { category: string; items: { name: string; value: number }[] }[];
  years: { year: string; count: number }[];
}

interface BreachDetails {
  breach: string;
  xposed_date: string;
  domain: string;
  industry: string;
  xposed_data: string;
  details: string;
  references: string;
  password_risk: string;
}

interface PasswordCheckResult {
  found: boolean;
  count: number;
  digits: number;
  alphabets: number;
  specialChars: number;
  length: number;
}

interface LeakCheckResponse {
  success: boolean;
  found: number;
  fields?: string[];
  sources: { name: string; date?: string }[];
}

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
export class LeakCheckService {
  private readonly logger = new Logger(LeakCheckService.name);
  private monitoredEmails: Set<string> = new Set();
  private readonly MONITOR_INTERVAL = 24 * 60 * 60 * 1000;

  constructor(
    private readonly httpService: HttpService,
    private readonly redisService: RedisService,
    private readonly puppeteerService: PuppeteerService,
    @Inject(forwardRef(() => BotService))
    private readonly botService: BotService,
  ) {
    this.startMonitoring();
  }

  async monitorEmail(email: string, chatId: number): Promise<void> {
    this.monitoredEmails.add(email);
    await this.redisService.set(`monitor:${email}`, chatId, 0);
    this.logger.log(`Started monitoring email: ${email}`);
  }

  private startMonitoring(): void {
    setInterval(() => {
      this.monitorEmails().catch((error) =>
        this.logger.error(`Monitoring failed: ${(error as Error).message}`),
      );
    }, this.MONITOR_INTERVAL);
  }

  private async monitorEmails(): Promise<void> {
    for (const email of this.monitoredEmails) {
      const chatId = await this.redisService.get(`monitor:${email}`);
      if (!chatId) continue;

      const breaches = await this.checkEmailBreaches(email, Number(chatId));
      const cacheKey = `email:${email}`;
      const previousBreaches = await this.redisService.get<Breach[]>(cacheKey);

      const newBreaches = breaches.filter(
        (breach) =>
          !previousBreaches?.some(
            (prev) =>
              prev.Name === breach.Name && prev.Domain === breach.Domain,
          ),
      );

      if (newBreaches.length > 0) {
        const message = `
🔔 *Новые утечки для ${email}!*

${newBreaches
  .map((b) => `- *${b.Name}*${b.Domain ? ` (${b.Domain})` : ''}`)
  .join('\n')}
        `;
        await this.botService.sendProgressMessage(Number(chatId), message);
      }

      await this.redisService.set(cacheKey, breaches, 24 * 60 * 60);
    }
  }

  async checkEmailBreaches(email: string, chatId: number): Promise<Breach[]> {
    if (!email) {
      this.logger.warn('Empty email provided');
      return [];
    }

    // Валидация email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      this.logger.warn(`Invalid email format: ${email}`);
      return [];
    }

    await this.botService.sendProgressMessage(
      chatId,
      '🔍 Начинаю проверку утечек...',
    );

    const cacheKey = `email:${email}`;
    const cached = await this.redisService.get<Breach[]>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      await this.botService.sendProgressMessage(
        chatId,
        '📦 Результаты найдены в кэше, обрабатываю...',
      );
      return cached;
    }

    const results = await Promise.allSettled([
      this.checkLeakCheck(email),
      this.checkXposedOrNot(email),
      // this.checkHaveIBeenPwned(email),
    ]);

    const breaches: Breach[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        breaches.push(...result.value);
      } else {
        this.logger.warn(
          `API ${['LeakCheck', 'XposedOrNot', 'HIBP'][index]} failed: ${
            (result.reason as Error).message
          }`,
        );
      }
    });

    const uniqueBreaches = this.removeDuplicates(breaches);
    await this.redisService.set(cacheKey, uniqueBreaches, 24 * 60 * 60);
    this.logger.log(`Stored ${uniqueBreaches.length} breaches for ${email}`);
    return uniqueBreaches;
  }

  async getBreachAnalytics(email: string): Promise<Analytics> {
    if (!email) {
      this.logger.warn('Empty email provided');
      return this.getEmptyAnalytics();
    }

    const cacheKey = `analytics:${email}`;
    const cached = await this.redisService.get<Analytics>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    const analytics = await this.fetchXposedOrNotAnalytics(email);
    await this.redisService.set(cacheKey, analytics, 7 * 24 * 60 * 60);
    this.logger.log(`Stored analytics for ${email}`);
    return analytics;
  }

  async checkPassword(password: string): Promise<PasswordCheckResult> {
    if (!password) {
      this.logger.warn('Empty password provided');
      return this.computePasswordStats('');
    }

    const hash = keccak512(password);
    const cacheKey = `password:${hash}`;
    const cached = await this.redisService.get<PasswordCheckResult>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    const hashPrefix = hash.slice(0, 10);
    const url = `https://passwords.xposedornot.com/api/v1/pass/anon/${hashPrefix}`;

    try {
      const result =
        await this.puppeteerService.scrapeJSON<PasswordCheckResponse>(url);

      if (result.Error === 'Not found') {
        const computed = this.computePasswordStats(password);
        await this.redisService.set(cacheKey, computed, 24 * 60 * 60);
        return computed;
      }

      const { SearchPassAnon } = result;
      if (!SearchPassAnon) {
        this.logger.warn(
          `Invalid password check response: ${JSON.stringify(result)}`,
        );
        const computed = this.computePasswordStats(password);
        await this.redisService.set(cacheKey, computed, 24 * 60 * 60);
        return computed;
      }

      const charMatch = SearchPassAnon.char.match(
        /D:(\d+);A:(\d+);S:(\d+);L:(\d+)/,
      );
      const [_, digits, alphabets, specialChars, length] = charMatch
        ? charMatch.map(Number)
        : [null, 0, 0, 0, 0];

      const finalResult = {
        found: true,
        count: parseInt(SearchPassAnon.count, 10) || 0,
        digits,
        alphabets,
        specialChars,
        length,
      };

      await this.redisService.set(cacheKey, finalResult, 24 * 60 * 60);
      return finalResult;
    } catch (error) {
      this.logger.warn(`Password check failed: ${(error as Error).message}`);
      const computed = this.computePasswordStats(password);
      await this.redisService.set(cacheKey, computed, 24 * 60 * 60);
      return computed;
    }
  }

  private async checkLeakCheck(email: string): Promise<Breach[]> {
    const cacheKey = `leakcheck:${email}`;
    const cached = await this.redisService.get<Breach[]>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    const url = `https://leakcheck.io/api/public?key=YOUR_KEY&check=${encodeURIComponent(email)}`;
    try {
      const response = await firstValueFrom(
        this.httpService.get<LeakCheckResponse>(url, {
          headers: {
            'User-Agent': 'LeakGuardBot/1.0 (https://t.me/leak_guard_bot)',
            Accept: 'application/json',
          },
        }),
      );

      if (!response.data.success) {
        this.logger.warn(`LeakCheck failed for ${email}`);
        return [];
      }

      const breaches = response.data.sources.map((source) => ({
        Name: source.name,
        Domain: undefined,
        BreachDate: source.date,
      }));

      await this.redisService.set(cacheKey, breaches, 24 * 60 * 60);
      return breaches;
    } catch (error) {
      this.logger.warn(
        `LeakCheck error for ${email}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  private async checkXposedOrNot(email: string): Promise<Breach[]> {
    const cacheKey = `xposed:${email}`;
    const cached = await this.redisService.get<Breach[]>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    try {
      const url = `https://api.xposedornot.com/v1/check-email/${encodeURIComponent(email)}?include_details=false`;
      const result =
        await this.puppeteerService.scrapeJSON<XposedOrNotCheckResponse>(url);

      const breaches = (result.breaches?.[0] || []).map((name: string) => ({
        Name: name,
        Domain: undefined,
        BreachDate: undefined,
      }));

      await this.redisService.set(cacheKey, breaches, 24 * 60 * 60);
      return breaches;
    } catch (error) {
      this.logger.warn(
        `XposedOrNot failed for ${email}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  private async fetchXposedOrNotAnalytics(email: string): Promise<Analytics> {
    const cacheKey = `xposed_analytics:${email}`;
    const cached = await this.redisService.get<Analytics>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    try {
      const url = `https://api.xposedornot.com/v1/breach-analytics?email=${encodeURIComponent(email)}`;
      const result =
        await this.puppeteerService.scrapeJSON<XposedOrNotAnalyticsResponse>(
          url,
        );

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

      await this.redisService.set(cacheKey, analytics, 7 * 24 * 60 * 60);
      return analytics;
    } catch (error) {
      this.logger.warn(
        `XposedOrNot analytics failed for ${email}: ${(error as Error).message}`,
      );
      return this.getEmptyAnalytics();
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

  private removeDuplicates(breaches: Breach[]): Breach[] {
    const seen = new Set<string>();
    return breaches.filter((breach) => {
      const key = breach.Name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private getEmptyAnalytics(): Analytics {
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
