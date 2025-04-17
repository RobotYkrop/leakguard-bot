import { forwardRef, Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { BotUpdate } from './bot.update';
import { BotService } from './bot.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LeakCheckModule } from '../leak-check/leak-check.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule,
    TelegrafModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const token = configService.get<string>('TELEGRAM_BOT_TOKEN');
        if (!token) {
          throw new Error('TELEGRAM_BOT_TOKEN is not defined in .env');
        }
        return { token };
      },
      inject: [ConfigService],
    }),
    forwardRef(() => LeakCheckModule),
    RedisModule,
  ],
  providers: [BotUpdate, BotService],
  exports: [BotService],
})
export class BotModule {}
