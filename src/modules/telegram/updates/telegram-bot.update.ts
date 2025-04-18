import { Injectable, Logger } from '@nestjs/common';
import { Context, Markup } from 'telegraf';
import { Update, Start, Ctx, Action, On, Command } from 'nestjs-telegraf';
import { Message, CallbackQuery } from 'telegraf/typings/core/types/typegram';
import { TelegramBotService } from '../services/telegram-bot.service';
import { AppError } from 'src/common/errors/app.error';
import { BreachCheckService } from 'src/modules/breach-check/services/breach-check.service';

enum UserState {
  NONE = 'none',
  AWAITING_PASSWORD = 'awaiting_password',
  AWAITING_EMAIL = 'awaiting_email',
  AWAITING_MONITOR_EMAIL = 'awaiting_monitor_email',
}

interface UserData {
  state: UserState;
  attempts: number;
}

@Injectable()
@Update()
export class TelegramBotUpdate {
  private readonly logger = new Logger(TelegramBotUpdate.name);
  private readonly userStates = new Map<number, UserData>();
  private readonly MAX_ATTEMPTS = 3;
  private readonly ADMIN_IDS = [855779091];

  constructor(
    private readonly botService: TelegramBotService,
    private readonly breachCheckService: BreachCheckService,
  ) {
    this.logger.log('TelegramBotUpdate initialized');
  }

  private getWelcomeMessage(): string {
    return (
      '👋 *Добро пожаловать в LeakGuardBot!*\n\n' +
      'Я помогу проверить, не были ли ваши данные скомпрометированы. Вы можете проверить email или пароль.\n\n' +
      'Что хотите проверить?'
    );
  }

  @Start()
  async start(@Ctx() ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(
        '❌ Не удалось определить пользователя. Попробуйте снова.',
      );
      return;
    }

    this.logger.log(`User ${userId} started the bot`);
    this.userStates.delete(userId);
    await ctx.reply(
      this.getWelcomeMessage(),
      Markup.inlineKeyboard([
        [Markup.button.callback('🔑 Проверить пароль', 'check_password')],
        [Markup.button.callback('📧 Проверить email', 'check_email')],
      ]),
    );
  }

  @Command('monitor')
  async monitorEmailCommand(@Ctx() ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(
        '❌ Не удалось определить пользователя. Попробуйте снова.',
      );
      return;
    }

    this.userStates.set(userId, {
      state: UserState.AWAITING_MONITOR_EMAIL,
      attempts: 0,
    });
    await ctx.reply('📧 Введите email для мониторинга новых утечек:');
  }

  @Command('check')
  async checkEmailCommand(@Ctx() ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(
        '❌ Не удалось определить пользователя. Попробуйте снова.',
      );
      return;
    }

    this.userStates.set(userId, {
      state: UserState.AWAITING_EMAIL,
      attempts: 0,
    });
    await ctx.reply('📧 Введите email для проверки:');
  }

  @Command('password')
  async checkPasswordCommand(@Ctx() ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(
        '❌ Не удалось определить пользователя. Попробуйте снова.',
      );
      return;
    }

    this.userStates.set(userId, {
      state: UserState.AWAITING_PASSWORD,
      attempts: 0,
    });
    await ctx.reply('🔑 Введите пароль для проверки:');
  }

  @Action('check_password')
  async onCheckPasswordAction(@Ctx() ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(
        '❌ Не удалось определить пользователя. Попробуйте снова.',
      );
      return;
    }

    this.userStates.set(userId, {
      state: UserState.AWAITING_PASSWORD,
      attempts: 0,
    });
    await ctx.reply('🔑 Введите пароль для проверки:');
  }

  @Action('check_email')
  async onCheckEmailAction(@Ctx() ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(
        '❌ Не удалось определить пользователя. Попробуйте снова.',
      );
      return;
    }

    this.userStates.set(userId, {
      state: UserState.AWAITING_EMAIL,
      attempts: 0,
    });
    await ctx.reply('📧 Введите email для проверки:');
  }

  @On('text')
  async onText(@Ctx() ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(
        '❌ Не удалось определить пользователя. Попробуйте снова.',
      );
      return;
    }

    const message = ctx.message as Message.TextMessage | undefined;
    if (!message || !('text' in message)) {
      await ctx.reply('❌ Не удалось обработать сообщение. Попробуйте снова.');
      return;
    }

    const text = message.text.trim();
    if (!text) {
      await ctx.reply('❌ Пустое сообщение. Попробуйте снова.');
      return;
    }

    const userData = this.userStates.get(userId);
    if (!userData || userData.state === UserState.NONE) {
      await ctx.reply(
        'Пожалуйста, выберите действие с помощью кнопок или команд.',
        Markup.inlineKeyboard([
          [Markup.button.callback('🔑 Проверить пароль', 'check_password')],
          [Markup.button.callback('📧 Проверить email', 'check_email')],
        ]),
      );
      return;
    }

    try {
      if (userData.state === UserState.AWAITING_PASSWORD) {
        this.logger.log(`User ${userId} submitted password for check`);
        const result = await this.botService.checkPassword(text);
        await ctx.reply(result, { parse_mode: 'Markdown' });
        this.userStates.delete(userId);
      } else if (userData.state === UserState.AWAITING_EMAIL) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(text)) {
          userData.attempts += 1;
          this.userStates.set(userId, userData);
          if (userData.attempts >= this.MAX_ATTEMPTS) {
            this.userStates.delete(userId);
            await ctx.reply(
              `❌ Слишком много неверных попыток.\n\n${this.getWelcomeMessage()}`,
              Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    '🔑 Проверить пароль',
                    'check_password',
                  ),
                ],
                [Markup.button.callback('📧 Проверить email', 'check_email')],
              ]),
            );
          } else {
            await ctx.reply(
              `❌ Неверный формат email. Попробуйте снова (осталось попыток: ${this.MAX_ATTEMPTS - userData.attempts}).`,
            );
          }
          return;
        }

        this.logger.log(`User ${userId} submitted email for check: ${text}`);
        const result = await this.botService.checkEmail(text, userId);
        this.logger.debug(
          `Sending email check result to ${userId}: ${result.message}`,
        );
        if (result.message.length > 4096) {
          await ctx.reply(
            `❌ Результат слишком длинный для отображения. Пожалуйста, запросите аналитику для подробностей.`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '📊 Аналитика',
                      callback_data: `analytics:${text}`,
                    },
                  ],
                ],
              },
            },
          );
        } else {
          await ctx.reply(result.message, {
            parse_mode: 'Markdown',
            ...(result.reply_markup
              ? { reply_markup: result.reply_markup }
              : {}),
          });
        }
        this.userStates.delete(userId);
      } else if (userData.state === UserState.AWAITING_MONITOR_EMAIL) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(text)) {
          userData.attempts += 1;
          this.userStates.set(userId, userData);
          if (userData.attempts >= this.MAX_ATTEMPTS) {
            this.userStates.delete(userId);
            await ctx.reply(
              `❌ Слишком много неверных попыток.\n\n${this.getWelcomeMessage()}`,
              Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    '🔑 Проверить пароль',
                    'check_password',
                  ),
                ],
                [Markup.button.callback('📧 Проверить email', 'check_email')],
              ]),
            );
          } else {
            await ctx.reply(
              `❌ Неверный формат email. Попробуйте снова (осталось попыток: ${this.MAX_ATTEMPTS - userData.attempts}).`,
            );
          }
          return;
        }

        this.logger.log(
          `User ${userId} submitted email for monitoring: ${text}`,
        );
        await this.breachCheckService.monitorEmail(text, userId);
        await ctx.reply(`✅ Email *${text}* добавлен в мониторинг.`);
        this.userStates.delete(userId);
      }
    } catch (error) {
      this.logger.warn(
        `Error processing input for user ${userId}: ${(error as Error).message}`,
      );
      if (error instanceof AppError && error.code === 'INVALID_EMAIL') {
        await ctx.reply('❌ Неверный формат email. Попробуйте снова.');
      } else {
        await ctx.reply('❌ Произошла ошибка. Попробуйте снова.');
      }
    }
  }

  @Command('clearcache')
  async clearCache(@Ctx() ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(
        '❌ Не удалось определить пользователя. Попробуйте снова.',
      );
      return;
    }
    if (!this.ADMIN_IDS.includes(userId)) {
      await ctx.reply('❌ Команда доступна только администраторам.');
      return;
    }

    this.logger.log(`User ${userId} requested cache clear`);
    const result = await this.botService.clearCache();
    await ctx.reply(result, { parse_mode: 'Markdown' });
  }

  @Command('clearemailcache')
  async clearEmailCache(@Ctx() ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(
        '❌ Не удалось определить пользователя. Попробуйте снова.',
      );
      return;
    }
    if (!this.ADMIN_IDS.includes(userId)) {
      await ctx.reply('❌ Команда доступна только администраторам.');
      return;
    }

    this.logger.log(`User ${userId} requested email cache clear`);
    const result = await this.botService.clearEmailCache();
    await ctx.reply(result, { parse_mode: 'Markdown' });
  }

  @Command('stats')
  async getStats(@Ctx() ctx: Context) {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply(
        '❌ Не удалось определить пользователя. Попробуйте снова.',
      );
      return;
    }
    if (!this.ADMIN_IDS.includes(userId)) {
      await ctx.reply('❌ Команда доступна только администраторам.');
      return;
    }

    this.logger.log(`User ${userId} requested stats`);
    const result = await this.botService.getStats();
    await ctx.reply(result, { parse_mode: 'Markdown' });
  }

  @Action(/analytics:(.+)/)
  async onAnalytics(@Ctx() ctx: Context) {
    const callbackQuery = ctx.callbackQuery as
      | CallbackQuery.DataQuery
      | undefined;
    if (!callbackQuery || !('data' in callbackQuery)) {
      await ctx.reply('❌ Не удалось обработать запрос аналитики.');
      return;
    }

    const match = callbackQuery.data.match(/analytics:(.+)/);
    const email = match?.[1];
    if (!email) {
      await ctx.reply('❌ Не удалось определить email для аналитики.');
      return;
    }

    this.logger.log(`User ${ctx.from?.id} requested analytics for ${email}`);
    const analytics = await this.botService.getAnalytics(email);
    if (analytics.length > 4096) {
      await ctx.reply(
        '❌ Аналитика слишком длинная для отображения. Пожалуйста, запросите проверку конкретных данных.',
        { parse_mode: 'Markdown' },
      );
    } else {
      await ctx.reply(analytics, { parse_mode: 'Markdown' });
    }
  }
}
