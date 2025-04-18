import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import puppeteer, { Browser, Page, HTTPResponse } from 'puppeteer';
import { PuppeteerExtra, PuppeteerExtraPlugin } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AnonymizeUA from 'puppeteer-extra-plugin-anonymize-ua';
import { AppError } from '../../common/errors/app.error';

@Injectable()
export class PuppeteerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PuppeteerService.name);
  private browser: Browser | null = null;
  private pagePool: Page[] = [];
  private readonly maxPages = 5;
  private readonly userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  ];

  async onModuleInit(): Promise<void> {
    try {
      const puppeteerExtra = new PuppeteerExtra(puppeteer);
      puppeteerExtra.use(StealthPlugin());
      puppeteerExtra.use(AnonymizeUA() as PuppeteerExtraPlugin);

      this.browser = await puppeteerExtra.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--window-size=1920,1080',
          '--disable-blink-features=AutomationControlled',
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      });
      this.logger.log('Puppeteer browser initialized');

      for (let i = 0; i < this.maxPages; i++) {
        await this.addPageToPool();
      }
    } catch (error) {
      this.logger.error(
        `Failed to initialize Puppeteer: ${(error as Error).message}`,
      );
      throw new AppError(
        `Puppeteer initialization failed`,
        500,
        'PUPPETEER_ERROR',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      await Promise.all(this.pagePool.map((page) => page.close()));
      await this.browser.close();
      this.logger.log('Puppeteer browser closed');
    }
  }

  private async addPageToPool(): Promise<void> {
    if (!this.browser)
      throw new AppError('Browser not initialized', 500, 'PUPPETEER_ERROR');
    const page = await this.browser.newPage();
    await page.setUserAgent(this.getRandomUserAgent());
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'application/json, text/plain, */*',
    });
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
    this.pagePool.push(page);
  }

  private getRandomUserAgent(): string {
    return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
  }

  private async getPageFromPool(): Promise<Page> {
    if (this.pagePool.length === 0) {
      await this.addPageToPool();
    }
    return this.pagePool.shift()!;
  }

  private releasePage(page: Page): void {
    this.pagePool.push(page);
  }

  private async getCfClearance(
    page: Page,
    url: string,
    retries = 1,
  ): Promise<string> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        this.logger.debug(
          `Attempt ${attempt} to obtain cf_clearance for ${url}`,
        );

        // Навигация на страницу
        const response = await page.goto(url, {
          waitUntil: 'networkidle0',
          timeout: 60000,
        });

        if (response?.status() === 403) {
          this.logger.warn(`Received 403 on attempt ${attempt} for ${url}`);
          if (attempt === retries) {
            throw new Error('Access denied by Cloudflare after all attempts');
          }
        }

        // Ждём завершения проверки Cloudflare
        await page
          .waitForFunction(
            () =>
              !document
                .querySelector('title')
                ?.innerText.includes('Just a moment'),
            { timeout: 30000 },
          )
          .catch(() => {
            this.logger.warn(
              `Cloudflare check not completed on attempt ${attempt}`,
            );
          });

        // Проверяем Turnstile, если присутствует
        const hasTurnstile = await page.evaluate(() => {
          return !!document.querySelector(
            'input[name="cf-turnstile-response"]',
          );
        });

        if (hasTurnstile) {
          this.logger.debug('Turnstile detected, waiting for token...');
          await page.waitForFunction(
            () => {
              const turnstile = document.querySelector(
                'input[name="cf-turnstile-response"]',
              );
              return turnstile && (turnstile as HTMLInputElement).value;
            },
            { timeout: 15000 },
          );

          const turnstileToken = await page.evaluate(() => {
            const turnstile = document.querySelector(
              'input[name="cf-turnstile-response"]',
            );
            return turnstile ? (turnstile as HTMLInputElement).value : null;
          });

          if (!turnstileToken) {
            throw new Error('Failed to obtain Cloudflare Turnstile token');
          }
          this.logger.debug(`Turnstile token obtained: ${turnstileToken}`);
        }

        // Извлекаем cf_clearance
        const cookies = await page.cookies();
        const clearanceCookie = cookies.find(
          (cookie) => cookie.name === 'cf_clearance',
        );

        if (clearanceCookie) {
          this.logger.debug(`cf_clearance obtained: ${clearanceCookie.value}`);
          return clearanceCookie.value;
        }

        this.logger.warn(`cf_clearance not found on attempt ${attempt}`);
        if (attempt < retries) {
          await page.reload({ waitUntil: 'networkidle0', timeout: 30000 });
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      } catch (error) {
        this.logger.warn(
          `Attempt ${attempt} failed: ${(error as Error).message}`,
        );
        if (attempt === retries) {
          throw new Error(
            `Failed to obtain cf_clearance after ${retries} attempts: ${(error as Error).message}`,
          );
        }
      }
    }

    throw new Error('Failed to obtain cf_clearance after all attempts');
  }

  async scrapeJSON<T = unknown>(url: string, retries = 3): Promise<T> {
    const page = await this.getPageFromPool();
    try {
      this.logger.debug(`Navigating to ${url}`);
      // const cfClearance = await this.getCfClearance(page, url, retries);
      await page.setCookie({
        name: 'cf_clearance',
        value: '',
        domain: new URL(url).hostname,
      });

      let responseData: T | null = null;
      const handleResponse = (response: HTTPResponse): void => {
        if (response.url() === url) {
          // Используем IIFE для асинхронной логики
          void (async () => {
            try {
              const text = await response.text();
              this.logger.debug(`Raw response: ${text.slice(0, 100)}...`);
              responseData = JSON.parse(text) as T;
            } catch (error) {
              this.logger.warn(
                `Failed to parse JSON response: ${(error as Error).message}`,
              );
            }
          })();
        }
      };

      page.on('response', handleResponse);
      const response = await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      if (response?.status() === 403)
        throw new AppError(
          'Access denied by Cloudflare',
          403,
          'CLOUDFLARE_ERROR',
        );
      if (response?.status() === 429)
        throw new AppError('Too many requests', 429, 'RATE_LIMIT_ERROR');

      await page.waitForFunction(() => !!window.fetch, { timeout: 30000 });

      if (!responseData) {
        responseData = await page.evaluate(() => {
          try {
            return JSON.parse(document.body.innerText) as T;
          } catch {
            return null;
          }
        });
      }

      if (!responseData)
        throw new AppError(
          `Failed to retrieve JSON data from ${url}`,
          500,
          'SCRAPE_ERROR',
        );
      return responseData;
    } finally {
      this.releasePage(page);
    }
  }
}
