import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { LeakCheckService } from '../leak-check/leak-check.service';
import { InlineKeyboardMarkup } from 'telegraf/typings/core/types/typegram';
import { RedisService } from './redis/redis.service';

interface CheckResult {
  message: string;
  reply_markup?: InlineKeyboardMarkup;
}

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);
  private readonly STATS_KEY = 'bot:stats';

  constructor(
    @InjectBot() private readonly bot: Telegraf,
    private readonly leakCheckService: LeakCheckService,
    private readonly redisService: RedisService,
  ) {}

  // Экранирование специальных символов для Markdown
  private escapeMarkdown(text: string): string {
    return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }

  async sendProgressMessage(chatId: number, message: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
      });
      this.logger.log(`Sent progress message to chat ${chatId}: ${message}`);
    } catch (error) {
      this.logger.error(
        `Failed to send progress message to chat ${chatId}: ${(error as Error).message}`,
      );
    }
  }

  async checkEmail(email: string, chatId: number): Promise<CheckResult> {
    await this.incrementStat('email_checks');
    const breaches = await this.leakCheckService.checkEmailBreaches(
      email,
      chatId,
    );
    if (!breaches.length) {
      return {
        message: '🎉 *Хорошие новости!* Ваш email не найден в утечках.',
      };
    }

    const lines = breaches
      .map((b) => {
        const parts = [`- *${this.escapeMarkdown(b.Name)}*`];
        if (b.BreachDate)
          parts.push(`  📅 Дата: ${this.escapeMarkdown(b.BreachDate)}`);
        if (b.Domain)
          parts.push(`  🌐 Домен: ${this.escapeMarkdown(b.Domain)}`);
        return parts;
      })
      .flat();

    const message = `
🚨 *Найдены утечки данных* 🚨
Ваш email *${this.escapeMarkdown(email)}* был найден в следующих утечках:

${lines.join('\n')}

🔐 *Рекомендации*:
- Смените пароли для затронутых сервисов.
- Включите двухфакторную аутентификацию (2FA).
- Используйте менеджер паролей для генерации сложных паролей.
    `;

    const reply_markup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [{ text: '📊 Аналитика', callback_data: `analytics:${email}` }],
      ],
    };
    return { message, reply_markup };
  }

  async getAnalytics(email: string): Promise<string> {
    await this.incrementStat('analytics_requests');
    const analytics = await this.leakCheckService.getBreachAnalytics(email);
    const lines: string[] = [];

    if (analytics.breachesDetails.length) {
      lines.push('📋 *Подробности утечек:*');
      analytics.breachesDetails.forEach((b) => {
        lines.push(`- *${this.escapeMarkdown(b.breach)}*:`);
        lines.push(`  📅 Дата: ${this.escapeMarkdown(b.xposed_date)}`);
        lines.push(`  🌐 Домен: ${this.escapeMarkdown(b.domain)}`);
        lines.push(`  🏭 Индустрия: ${this.escapeMarkdown(b.industry)}`);
        lines.push(`  📜 Описание: ${this.escapeMarkdown(b.details)}`);
        lines.push(
          `  📂 Скомпрометированные данные: ${this.escapeMarkdown(b.xposed_data)}`,
        );
        lines.push(`  🔐 Тип пароля: ${this.escapeMarkdown(b.password_risk)}`);
      });
    }

    if (analytics.industries.length) {
      lines.push('\n🏭 *Индустрии утечек:*');
      analytics.industries.forEach((i) => {
        lines.push(`• ${this.escapeMarkdown(i.name)} (${i.count})`);
      });
    }

    if (analytics.passwordStrength) {
      lines.push('\n🔐 *Статистика паролей:*');
      lines.push(
        `• Легко взламываемые: ${analytics.passwordStrength.PlainText}`,
        `• Надёжные (хэшированные): ${analytics.passwordStrength.StrongHash}`,
        `• Неизвестно: ${analytics.passwordStrength.Unknown}`,
      );
    }

    if (analytics.risk) {
      lines.push(
        `\n⚠️ *Уровень риска:* ${this.escapeMarkdown(analytics.risk.label)} (оценка: ${analytics.risk.score})`,
      );
    }

    if (analytics.exposedData.length) {
      lines.push('\n📂 *Скомпрометированные данные по категориям:*');
      analytics.exposedData.forEach((category) => {
        lines.push(`${this.escapeMarkdown(category.category)}:`);
        category.items.forEach((item) => {
          lines.push(`• ${this.escapeMarkdown(item.name)}: ${item.value}`);
        });
      });
    }

    if (analytics.years.length) {
      lines.push('\n📅 *Годы утечек:*');
      analytics.years.forEach((y) => {
        lines.push(`• ${y.year}: ${y.count}`);
      });
    }

    const message = lines.length
      ? lines.join('\n')
      : '📊 *Аналитика недоступна.*';

    // Проверяем длину сообщения (ограничение Telegram — 4096 символов)
    if (message.length > 4096) {
      return '📊 *Аналитика слишком длинная для отображения.* Пожалуйста, запросите проверку конкретных данных.';
    }

    return message;
  }

  async checkPassword(password: string): Promise<string> {
    await this.incrementStat('password_checks');
    const result = await this.leakCheckService.checkPassword(password);
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
    return lines.filter(Boolean).join('\n');
  }

  async clearCache(): Promise<string> {
    try {
      await this.redisService.clearCache();
      return '✅ Кэш успешно очищен!';
    } catch (error) {
      this.logger.error(`Failed to clear cache: ${(error as Error).message}`);
      return '❌ Не удалось очистить кэш. Попробуйте позже.';
    }
  }

  async clearEmailCache(): Promise<string> {
    try {
      await this.redisService.clearCacheByPattern('email:*');
      return '✅ Кэш email успешно очищен!';
    } catch (error) {
      this.logger.error(
        `Failed to clear email cache: ${(error as Error).message}`,
      );
      return '❌ Не удалось очистить кэш email. Попробуйте позже.';
    }
  }

  private async incrementStat(metric: string): Promise<void> {
    try {
      await this.redisService.increment(`${this.STATS_KEY}:${metric}`);
    } catch (error) {
      this.logger.error(
        `Failed to increment stat ${metric}: ${(error as Error).message}`,
      );
    }
  }

  async getStats(): Promise<string> {
    try {
      const emailChecks =
        (await this.redisService.get<number>(
          `${this.STATS_KEY}:email_checks`,
        )) || 0;
      const passwordChecks =
        (await this.redisService.get<number>(
          `${this.STATS_KEY}:password_checks`,
        )) || 0;
      const analyticsRequests =
        (await this.redisService.get<number>(
          `${this.STATS_KEY}:analytics_requests`,
        )) || 0;

      const message = `
📊 *Статистика использования бота* 📊

- Проверок email: ${emailChecks}
- Проверок паролей: ${passwordChecks}
- Запросов аналитики: ${analyticsRequests}
      `;

      if (message.length > 4096) {
        return '📊 *Статистика слишком длинная для отображения.*';
      }

      return message;
    } catch (error) {
      this.logger.error(
        `Failed to retrieve stats: ${(error as Error).message}`,
      );
      return '❌ Не удалось получить статистику. Попробуйте позже.';
    }
  }
}
