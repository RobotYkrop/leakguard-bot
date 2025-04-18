import { Module, forwardRef, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegrafModule } from 'nestjs-telegraf';
import { BreachCheckModule } from '../breach-check/breach-check.module';
import { CacheModule } from '../cache/cache.module';
import { TelegramBotService } from './services/telegram-bot.service';
import { TelegramBotUpdate } from './updates/telegram-bot.update';

@Module({
  imports: [
    ConfigModule,
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const token = configService.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
        return { token };
      },
      inject: [ConfigService],
    }),
    forwardRef(() => BreachCheckModule),
    CacheModule,
  ],
  providers: [TelegramBotService, TelegramBotUpdate],
  exports: [TelegramBotService],
})
export class TelegramModule {
  private readonly logger = new Logger(TelegramModule.name);
  constructor() {
    this.logger.log('TelegramModule initialized');
  }
}
