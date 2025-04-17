import { Context, Markup } from 'telegraf';
import { Injectable, Logger } from '@nestjs/common';
import { BotService } from './bot.service';
import { Update, Start, Ctx, Action, On, Command } from 'nestjs-telegraf';
import { Message, CallbackQuery } from 'telegraf/typings/core/types/typegram';

@Injectable()
@Update()
export class BotUpdate {
  private readonly logger = new Logger(BotUpdate.name);
  private readonly userState: Map<number, { state: string; attempts: number }> =
    new Map();
  private readonly MAX_ATTEMPTS = 3;
  private readonly ADMIN_IDS = [855779091];

  constructor(private readonly botService: BotService) {}

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
    this.userState.delete(userId);
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

    this.userState.set(userId, {
      state: 'awaiting_monitor_email',
      attempts: 0,
    });
    await ctx.reply('📧 Введите email для мониторинга новых утечек:');
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

    this.userState.set(userId, { state: 'awaiting_password', attempts: 0 });
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

    this.userState.set(userId, { state: 'awaiting_email', attempts: 0 });
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

    const userData = this.userState.get(userId);
    if (!userData) {
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
      if (userData.state === 'awaiting_password') {
        this.logger.log(`User ${userId} submitted password for check`);
        const result = await this.botService.checkPassword(text);
        await ctx.reply(result, { parse_mode: 'Markdown' });
        this.userState.delete(userId);
      } else if (userData.state === 'awaiting_email') {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(text)) {
          userData.attempts += 1;
          this.userState.set(userId, userData);
          if (userData.attempts >= this.MAX_ATTEMPTS) {
            this.userState.delete(userId);
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
        await ctx.reply(result.message, {
          parse_mode: 'Markdown',
          ...(result.reply_markup ? { reply_markup: result.reply_markup } : {}),
        });
        this.userState.delete(userId);
      }
    } catch (error) {
      this.logger.warn(
        `Error processing input for user ${userId}: ${(error as Error).message}`,
      );
      await ctx.reply('❌ Произошла ошибка. Попробуйте снова.');
    }
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

    this.userState.set(userId, { state: 'awaiting_password', attempts: 0 });
    await ctx.reply('🔑 Введите пароль для проверки:');
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

    this.userState.set(userId, { state: 'awaiting_email', attempts: 0 });
    await ctx.reply('📧 Введите email для проверки:');
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
    await ctx.reply(analytics, { parse_mode: 'Markdown' });
  }
}
