import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { IBot } from 'src/common/interfaces/bot.interface';
import { BreachCheckService } from 'src/modules/breach-check/services/breach-check.service';
import { RedisCacheService } from 'src/modules/cache/redis/redis-cache.service';
import { Telegraf } from 'telegraf';
import {
  InlineKeyboardMarkup,
  ParseMode,
} from 'telegraf/typings/core/types/typegram';

interface CheckResult {
  message: string;
  reply_markup?: InlineKeyboardMarkup;
}

@Injectable()
export class TelegramBotService implements IBot {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly STATS_KEY = 'bot:stats';

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    @Inject(forwardRef(() => BreachCheckService))
    private readonly breachCheckService: BreachCheckService,
    private readonly cacheService: RedisCacheService,
  ) {
    this.logger.log('TelegramBotService initialized');
  }

  async sendMessage(
    chatId: number,
    message: string,
    options: { parse_mode?: ParseMode } = {},
  ): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, message, {
        parse_mode: options.parse_mode || 'Markdown',
        ...options,
      });
      this.logger.debug(`Sent message to chat ${chatId}: ${message}`);
    } catch (error) {
      this.logger.error(
        `Failed to send message to chat ${chatId}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async sendProgressMessage(chatId: number, message: string): Promise<void> {
    await this.sendMessage(chatId, message);
  }

  async checkEmail(email: string, chatId: number): Promise<CheckResult> {
    await this.incrementStat('email_checks');
    await this.sendProgressMessage(chatId, '🔍 Начинаю проверку утечек...');
    const breaches = await this.breachCheckService.checkEmailBreaches(email);
    await this.sendProgressMessage(
      chatId,
      '📦 Результаты получены, обрабатываю...',
    );
    this.logger.debug(`Found ${breaches.length} breaches for ${email}`);

    if (!breaches.length) {
      const message = `🎉 *Хорошие новости!* Ваш email *${email}* не найден в утечках.`;
      this.logger.debug(`Returning email check result: ${message}`);
      return { message };
    }

    const lines = breaches.map((b) => {
      this.logger.debug(
        `Processing breach: Name=${b.Name}, Domain=${b.Domain || 'N/A'}, BreachDate=${b.BreachDate || 'N/A'}`,
      );
      const parts = [`- *${b.Name}*`];
      if (b.BreachDate) parts.push(` 📅 Дата: ${b.BreachDate}`);
      if (b.Domain) parts.push(` 🌐 Домен: ${b.Domain}`);
      return parts.join('');
    });

    const message = `
🚨 *Найдены утечки данных* 🚨
Ваш email *${email}* был найден в следующих утечках:

${lines.join('\n')}

🔐 *Рекомендации*:
- Смените пароли для затронутых сервисов.
- Включите двухфакторную аутентификацию (2FA).
- Используйте менеджер паролей для генерации сложных паролей.
`;

    if (message.length > 4096) {
      const fallbackMessage = `
🚨 *Найдены утечки данных* 🚨
Ваш email *${email}* был найден в ${breaches.length} утечках. Слишком много данных для отображения.

🔐 *Рекомендации*:
- Смените пароли для затронутых сервисов.
- Включите двухфакторную аутентификацию (2FA).
- Используйте менеджер паролей для генерации сложных паролей.
`;
      this.logger.debug(
        `Message too long, returning fallback: ${fallbackMessage}`,
      );
      return {
        message: fallbackMessage,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📊 Аналитика',
                callback_data: `analytics:${email}`,
              },
            ],
          ],
        },
      };
    }

    const reply_markup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          {
            text: '📊 Аналитика',
            callback_data: `analytics:${email}`,
          },
        ],
      ],
    };
    this.logger.debug(`Returning email check result: ${message}`);
    return { message, reply_markup };
  }

  async checkPassword(password: string): Promise<string> {
    await this.incrementStat('password_checks');
    const result = await this.breachCheckService.checkPassword(password);
    this.logger.debug(`Password check result: ${JSON.stringify(result)}`);

    const lines = [
      result.found
        ? `⚠️ *Пароль найден в утечках!* (${result.count} раз)`
        : '✅ *Пароль не найден в утечках.*',
      result.count > 0
        ? `📊 Из них ${result.count} найдено через XposedOrNot.`
        : '',
      `🔢 Цифры: ${result.digits}`,
      `🔠 Буквы: ${result.alphabets}`,
      `🔣 Спецсимволы: ${result.specialChars}`,
      `📏 Длина: ${result.length}`,
      result.found
        ? '\n🔐 *Рекомендация*: Смените пароль на более сложный!'
        : '',
    ];
    const message = lines.filter(Boolean).join('\n');
    this.logger.debug(`Returning password check result: ${message}`);
    return message;
  }

  async getAnalytics(email: string): Promise<string> {
    await this.incrementStat('analytics_requests');
    const analytics = await this.breachCheckService.getAnalytics(email);
    this.logger.debug(
      `Analytics result for ${email}: ${JSON.stringify(analytics)}`,
    );
    const lines: string[] = [];

    if (analytics.breachesDetails.length) {
      lines.push('📋 *Подробности утечек:*');
      analytics.breachesDetails.forEach((b) => {
        lines.push(`- *${b.breach}*:`);
        lines.push(` 📅 Дата: ${b.xposed_date}`);
        lines.push(` 🌐 Домен: ${b.domain}`);
        lines.push(` 🏭 Индустрия: ${b.industry}`);
        lines.push(` 📜 Описание: ${b.details}`);
        lines.push(` 📂 Скомпрометированные данные: ${b.xposed_data}`);
        lines.push(` 🔐 Тип пароля: ${b.password_risk}`);
      });
    }

    if (analytics.industries.length) {
      lines.push('\n🏭 *Индустрии утечек:*');
      analytics.industries.forEach((i) => {
        lines.push(`- ${i.name} (${i.count})`);
      });
    }

    if (analytics.passwordStrength) {
      lines.push('\n🔐 *Статистика паролей:*');
      lines.push(
        `- Легко взламываемые: ${analytics.passwordStrength.PlainText}`,
      );
      lines.push(
        `- Надёжные (хэшированные): ${analytics.passwordStrength.StrongHash}`,
      );
      lines.push(`- Неизвестно: ${analytics.passwordStrength.Unknown}`);
    }

    if (analytics.risk) {
      lines.push(
        `\n⚠️ *Уровень риска:* ${analytics.risk.label} (оценка: ${analytics.risk.score})`,
      );
    }

    if (analytics.exposedData.length) {
      lines.push('\n📂 *Скомпрометированные данные по категориям:*');
      analytics.exposedData.forEach((category) => {
        lines.push(`${category.category}:`);
        category.items.forEach((item) => {
          // Исправляем опечатку и экранируем '_'
          const itemName = item.name
            .replace('data_Emmail addresses', 'data_Email addresses')
            .replace(/_/g, '\\_');
          lines.push(`- ${itemName}: ${item.value}`);
        });
      });
    }

    if (analytics.years.length) {
      lines.push('\n📅 *Годы утечек:*');
      analytics.years.forEach((y) => {
        lines.push(`- ${y.year}: ${y.count}`);
      });
    }

    const message = lines.length
      ? lines.join('\n')
      : '📊 *Аналитика недоступна.*';

    if (message.length > 4096) {
      return '📊 *Аналитика слишком длинная для отображения.* Пожалуйста, запросите проверку конкретных данных.';
    }

    this.logger.debug(`Returning analytics result: ${message}`);
    return message;
  }

  async clearCache(): Promise<string> {
    try {
      await this.cacheService.clearAll();
      this.logger.debug('Cache cleared');
      return '✅ Кэш успешно очищен!';
    } catch (error) {
      this.logger.error(`Failed to clear cache: ${(error as Error).message}`);
      return '❌ Не удалось очистить кэш. Попробуйте позже.';
    }
  }

  async clearEmailCache(): Promise<string> {
    try {
      await this.cacheService.clearByPattern('email:*');
      this.logger.debug('Email cache cleared');
      return '✅ Кэш email успешно очищен!';
    } catch (error) {
      this.logger.error(
        `Failed to clear email cache: ${(error as Error).message}`,
      );
      return '❌ Не удалось очистить кэш email. Попробуйте позже.';
    }
  }

  async getStats(): Promise<string> {
    try {
      const emailChecks =
        (await this.cacheService.get<number>(
          `${this.STATS_KEY}:email_checks`,
        )) || 0;
      const passwordChecks =
        (await this.cacheService.get<number>(
          `${this.STATS_KEY}:password_checks`,
        )) || 0;
      const analyticsRequests =
        (await this.cacheService.get<number>(
          `${this.STATS_KEY}:analytics_requests`,
        )) || 0;

      const message = `
📊 *Статистика использования бота* 📊

- Проверок email: ${emailChecks}
- Проверок паролей: ${passwordChecks}
- Запросов аналитики: ${analyticsRequests}
`;

      this.logger.debug(`Returning stats: ${message}`);
      return message;
    } catch (error) {
      this.logger.error(
        `Failed to retrieve stats: ${(error as Error).message}`,
      );
      return '❌ Не удалось получить статистику. Попробуйте позже.';
    }
  }

  private async incrementStat(metric: string): Promise<void> {
    try {
      await this.cacheService.increment(`${this.STATS_KEY}:${metric}`);
      this.logger.debug(`Incremented stat ${metric}`);
    } catch (error) {
      this.logger.error(
        `Failed to increment stat ${metric}: ${(error as Error).message}`,
      );
    }
  }
}

export { CheckResult };
