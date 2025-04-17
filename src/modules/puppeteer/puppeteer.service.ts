import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import puppeteer, { Browser, HTTPResponse, Page } from 'puppeteer';
import { PuppeteerExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

interface HIBPResponse {
  Breaches?: Array<{
    Name: string;
    Domain?: string;
    BreachDate?: string;
  }>;
  Pastes?: Array<{
    Id: string;
    Source: string;
    Title?: string;
    Date?: string;
    EmailCount: number;
  }>;
}

interface PostResponse {
  status: number | null;
  headers: Record<string, string> | null;
  data: unknown;
  error: string | null;
}

@Injectable()
export class PuppeteerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PuppeteerService.name);
  private browser: Browser | null = null;

  async onModuleInit(): Promise<void> {
    try {
      const puppeteerExtra = new PuppeteerExtra(puppeteer);
      puppeteerExtra.use(StealthPlugin());

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
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      });
      this.logger.log('Puppeteer browser initialized');
    } catch (error) {
      this.logger.error(
        `Failed to initialize Puppeteer: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.logger.log('Puppeteer browser closed');
    }
  }

  async getPage(): Promise<Page> {
    if (!this.browser) {
      throw new Error('Browser not initialized');
    }
    const page = await this.browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    );
    return page;
  }

  async scrapeHIBP(email: string, retries = 3): Promise<HIBPResponse | null> {
    const page = await this.getPage();
    try {
      const url = `https://haveibeenpwned.com/unifiedsearch/${encodeURIComponent(email)}`;
      this.logger.debug(`Navigating to ${url}`);

      let responseData: HIBPResponse | null = null;
      const handleResponse = async (response: HTTPResponse): Promise<void> => {
        if (response.url().includes('/unifiedsearch/')) {
          try {
            const text = await response.text();
            this.logger.debug(`Raw response: ${text.slice(0, 100)}...`);
            responseData = JSON.parse(text);
          } catch (error) {
            this.logger.warn(
              `Failed to parse response: ${(error as Error).message}`,
            );
            responseData = null;
          }
        }
      };

      page.on('response', (response) => {
        handleResponse(response).catch((error) =>
          this.logger.error(
            `Error handling response: ${(error as Error).message}`,
          ),
        );
      });

      const response = await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      if (response?.status() === 403) {
        this.logger.warn(`Access denied (403) for ${email}`);
        throw new Error('Access denied by Cloudflare');
      }

      if (response?.status() === 404) {
        this.logger.debug(`No breaches found for ${email} (404)`);
        return null;
      }

      const hasTurnstile = await page.evaluate(() => {
        return !!document.querySelector('input[name="cf-turnstile-response"]');
      });

      if (hasTurnstile) {
        this.logger.debug('Turnstile detected, waiting for token...');
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
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
            break;
          } catch (error) {
            if (attempt === retries) {
              this.logger.error(
                `Failed to obtain Turnstile token after ${retries} attempts: ${(error as Error).message}`,
              );
              throw error;
            }
            this.logger.warn(
              `Attempt ${attempt} failed to obtain Turnstile token: ${(error as Error).message}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      } else {
        this.logger.debug('No Turnstile detected, proceeding...');
      }

      await page.waitForFunction(() => !!window.fetch, { timeout: 30000 });

      if (!responseData) {
        responseData = await page.evaluate(() => {
          try {
            return JSON.parse(document.body.innerText) as HIBPResponse;
          } catch {
            return null;
          }
        });
      }

      if (!responseData) {
        throw new Error(
          `Failed to retrieve data from unifiedsearch for ${email}`,
        );
      }

      return responseData;
    } catch (error) {
      this.logger.error(
        `Failed to scrape HIBP for ${email}: ${(error as Error).message}`,
      );
      throw error;
    } finally {
      await page.close();
    }
  }

  async scrapeJSON<T = unknown>(url: string): Promise<T> {
    const page = await this.getPage();
    try {
      this.logger.debug(`Navigating to ${url}`);

      let responseData: T | null = null;
      const handleResponse = async (response: HTTPResponse): Promise<void> => {
        if (response.url() === url) {
          try {
            const text = await response.text();
            this.logger.debug(`Raw response: ${text.slice(0, 100)}...`);
            responseData = JSON.parse(text);
          } catch (error) {
            this.logger.warn(
              `Failed to parse JSON response: ${(error as Error).message}`,
            );
          }
        }
      };

      page.on('response', (response) => {
        handleResponse(response).catch((error) =>
          this.logger.error(
            `Error handling response: ${(error as Error).message}`,
          ),
        );
      });

      const response = await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      if (response?.status() === 403) {
        this.logger.warn(`Access denied (403) for ${url}`);
        throw new Error('Access denied by server');
      }

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

      if (!responseData) {
        throw new Error(`Failed to retrieve JSON data from ${url}`);
      }

      return responseData;
    } catch (error) {
      this.logger.error(
        `Failed to scrape JSON from ${url}: ${(error as Error).message}`,
      );
      throw error;
    } finally {
      await page.close();
    }
  }

  async scrapePostJSON<T = unknown>(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    retries = 3,
  ): Promise<T> {
    const page = await this.getPage();
    try {
      this.logger.debug(
        `Performing POST to ${url} with body: ${JSON.stringify(body)}`,
      );

      // Настраиваем Puppeteer, чтобы он выглядел как настоящий браузер
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      );
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://dehashed.com/',
        ...headers,
      });

      // Включаем cookies
      await page.setCookie({
        name: 'cf_clearance',
        value: process.env.CF_CLEARANCE_TOKEN || '',
        domain: '.dehashed.com',
      });

      // Загружаем страницу, чтобы пройти проверку Cloudflare
      this.logger.debug('Navigating to DeHashed to pass Cloudflare check...');
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });

      // Ждём, пока Cloudflare завершит проверку
      await page.waitForFunction(
        () =>
          !document.querySelector('title')?.innerText.includes('Just a moment'),
        { timeout: 30000 },
      );

      // Проверяем, есть ли Turnstile
      const hasTurnstile = await page.evaluate(() => {
        return !!document.querySelector('input[name="cf-turnstile-response"]');
      });

      if (hasTurnstile) {
        this.logger.debug('Turnstile detected, waiting for token...');
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
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
            break;
          } catch (error) {
            if (attempt === retries) {
              this.logger.error(
                `Failed to obtain Turnstile token after ${retries} attempts: ${(error as Error).message}`,
              );
              throw error;
            }
            this.logger.warn(
              `Attempt ${attempt} failed to obtain Turnstile token: ${(error as Error).message}`,
            );
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
      } else {
        this.logger.debug('No Turnstile detected, proceeding...');
      }

      // Выполняем POST-запрос после прохождения проверки
      const fetchResult = await page.evaluate(
        async (
          evalUrl: string,
          evalBody: Record<string, unknown>,
          evalHeaders: Record<string, string>,
        ): Promise<PostResponse> => {
          try {
            const response = await fetch(evalUrl, {
              method: 'POST',
              headers: evalHeaders,
              body: JSON.stringify(evalBody),
              credentials: 'include', // Включаем cookies
            });

            const status = response.status;
            const responseHeaders = Object.fromEntries(
              response.headers.entries(),
            );
            const text = await response.text();

            try {
              const json = JSON.parse(text);
              return {
                status,
                headers: responseHeaders,
                data: json,
                error: null,
              };
            } catch {
              return {
                status,
                headers: responseHeaders,
                data: null,
                error: text,
              };
            }
          } catch (error) {
            return {
              status: null,
              headers: null,
              data: null,
              error: (error as Error).message,
            };
          }
        },
        url,
        body,
        headers,
      );

      this.logger.debug(`Fetch result: ${JSON.stringify(fetchResult)}`);

      if (fetchResult.error) {
        this.logger.warn(`Fetch failed: ${fetchResult.error}`);
        if (fetchResult.status === 403) {
          this.logger.warn(`Access denied (403) for ${url}`);
          throw new Error('Access denied by server');
        }
        if (fetchResult.status === 401) {
          this.logger.warn(`Unauthorized (401) for ${url}`);
          throw new Error('Invalid API key');
        }
        throw new Error(`Fetch failed: ${fetchResult.error}`);
      }

      const responseData = fetchResult.data;

      if (!responseData) {
        throw new Error(`Failed to retrieve JSON data from ${url}`);
      }

      return responseData as T;
    } catch (error) {
      this.logger.error(
        `Failed to scrape POST JSON from ${url}: ${(error as Error).message}`,
      );
      throw error;
    } finally {
      await page.close();
    }
  }
}
