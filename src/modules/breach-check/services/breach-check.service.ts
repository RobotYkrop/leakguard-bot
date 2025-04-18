import { Injectable, Logger } from '@nestjs/common';
import { RedisCacheService } from '../../cache/redis/redis-cache.service';
import { Breach, PasswordCheckResult, Analytics } from '../types/breach.types';
import { LeakCheckApiService } from './leak-check-api.service';
import { XposedOrNotApiService } from './xposed-or-not-api.service';
import { keccak512 } from 'js-sha3';
import pTimeout from 'p-timeout';
import { AppError } from 'src/common/errors/app.error';
import { IBreachChecker } from 'src/common/interfaces/breach-checker.interface';
import { TelegramBotService } from 'src/modules/telegram/services/telegram-bot.service';

@Injectable()
export class BreachCheckService {
  private readonly logger = new Logger(BreachCheckService.name);
  private readonly checkers: IBreachChecker[];
  private readonly monitoredEmails: Set<string> = new Set();
  private readonly MONITOR_INTERVAL = 24 * 60 * 60 * 1000;
  private readonly CHECKER_TIMEOUT_MS = 35000; // 35 секунд

  constructor(
    private readonly cacheService: RedisCacheService,
    private readonly leakCheckApiService: LeakCheckApiService,
    private readonly xposedOrNotApiService: XposedOrNotApiService,
    private readonly telegramBotService: TelegramBotService,
  ) {
    this.logger.log('BreachCheckService initialized');
    this.checkers = [leakCheckApiService, xposedOrNotApiService];
    this.startMonitoring();
  }

  async checkEmailBreaches(email: string): Promise<Breach[]> {
    if (!this.isValidEmail(email)) {
      this.logger.warn(`Invalid email format: ${email}`);
      throw new AppError('Invalid email format', 400, 'INVALID_EMAIL');
    }

    const cacheKey = `email:${email}`;
    const cached = await this.cacheService.get<Breach[]>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    this.logger.log(`Checking breaches for ${email}`);
    const results = await Promise.allSettled(
      this.checkers.map((checker) =>
        pTimeout(checker.checkEmailBreaches(email), this.CHECKER_TIMEOUT_MS),
      ),
    );

    const breaches: Breach[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        breaches.push(...result.value);
        this.logger.debug(
          `Checker ${this.checkers[index].constructor.name} returned ${result.value.length} breaches`,
        );
      } else {
        this.logger.warn(
          `Checker ${this.checkers[index].constructor.name} failed: ${(result.reason as Error).message}`,
        );
      }
    });

    const uniqueBreaches = this.removeDuplicates(breaches);
    await this.cacheService.set(cacheKey, uniqueBreaches, 24 * 60 * 60);
    this.logger.log(`Stored ${uniqueBreaches.length} breaches for ${email}`);
    return uniqueBreaches;
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

    this.logger.log(`Checking password hash ${hash.slice(0, 10)}...`);
    const results = await Promise.allSettled(
      this.checkers.map((checker) =>
        pTimeout(checker.checkPassword(password), this.CHECKER_TIMEOUT_MS),
      ),
    );

    let finalResult: PasswordCheckResult = this.computePasswordStats(password);
    results.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.found) {
        finalResult = {
          ...finalResult,
          found: true,
          count: finalResult.count + result.value.count,
        };
        this.logger.debug(
          `Checker ${this.checkers[index].constructor.name} found password with count ${result.value.count}`,
        );
      } else if (result.status === 'rejected') {
        this.logger.warn(
          `Password check failed for ${this.checkers[index].constructor.name}: ${(result.reason as Error).message}`,
        );
      }
    });

    await this.cacheService.set(cacheKey, finalResult, 24 * 60 * 60);
    this.logger.log(
      `Stored password check result for hash ${hash.slice(0, 10)}...`,
    );
    return finalResult;
  }

  async getAnalytics(email: string): Promise<Analytics> {
    if (!this.isValidEmail(email)) {
      throw new AppError('Invalid email format', 400, 'INVALID_EMAIL');
    }

    const cacheKey = `analytics:${email}`;
    const cached = await this.cacheService.get<Analytics>(cacheKey);
    if (cached) {
      this.logger.debug(`Cache hit for ${cacheKey}`);
      return cached;
    }

    this.logger.log(`Fetching analytics for ${email}`);
    const results = await Promise.allSettled(
      this.checkers
        .filter((checker) => !!checker.getAnalytics)
        .map((checker) =>
          pTimeout(checker.getAnalytics!(email), this.CHECKER_TIMEOUT_MS),
        ),
    );

    let analytics: Analytics = this.getEmptyAnalytics();
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        analytics = result.value;
        this.logger.debug(
          `Checker ${this.checkers[index].constructor.name} returned analytics`,
        );
      } else {
        this.logger.warn(
          `Analytics failed for ${this.checkers[index].constructor.name}: ${(result.reason as Error).message}`,
        );
      }
    });

    await this.cacheService.set(cacheKey, analytics, 7 * 24 * 60 * 60);
    this.logger.log(`Stored analytics for ${email}`);
    return analytics;
  }

  async monitorEmail(email: string, chatId: number): Promise<void> {
    this.monitoredEmails.add(email);
    await this.cacheService.set(`monitor:${email}`, chatId, 0);
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
      const chatId = await this.cacheService.get<number>(`monitor:${email}`);
      if (!chatId) continue;

      const breaches = await this.checkEmailBreaches(email);
      const cacheKey = `email:${email}`;
      const previousBreaches = await this.cacheService.get<Breach[]>(cacheKey);

      const newBreaches = breaches.filter(
        (breach) =>
          !previousBreaches?.some(
            (prev: Breach) =>
              prev.Name === breach.Name && prev.Domain === breach.Domain,
          ),
      );

      if (newBreaches.length > 0) {
        const message = `
🔔 *Новые утечки для ${email}!*

${newBreaches.map((b) => `- *${b.Name}*${b.Domain ? ` (${b.Domain})` : ''}`).join('\n')}
`;
        await this.telegramBotService.sendMessage(chatId, message, {
          parse_mode: 'MarkdownV2',
        });
      }

      await this.cacheService.set(cacheKey, breaches, 24 * 60 * 60);
    }
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
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

  private hashPassword(password: string): string {
    return keccak512(password);
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
