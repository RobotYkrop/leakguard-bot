// src/modules/leak-check/leak-check.module.ts
import { forwardRef, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { LeakCheckService } from './leak-check.service';
import { RedisModule } from '../bot/redis/redis.module';
import { PuppeteerModule } from '../puppeteer/puppeteer.module';
import { BotModule } from '../bot/bot.module';

@Module({
  imports: [
    PuppeteerModule,
    HttpModule,
    RedisModule,
    forwardRef(() => BotModule),
  ],
  providers: [LeakCheckService],
  exports: [LeakCheckService],
})
export class LeakCheckModule {}
