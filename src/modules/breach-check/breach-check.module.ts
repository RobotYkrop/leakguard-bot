import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BreachCheckService } from './services/breach-check.service';
import { LeakCheckApiService } from './services/leak-check-api.service';
import { XposedOrNotApiService } from './services/xposed-or-not-api.service';
import { CacheModule } from '../cache/cache.module';
import { PuppeteerModule } from '../puppeteer/puppeteer.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [
    HttpModule,
    CacheModule,
    PuppeteerModule,
    forwardRef(() => TelegramModule),
  ],
  providers: [BreachCheckService, LeakCheckApiService, XposedOrNotApiService],
  exports: [BreachCheckService],
})
export class BreachCheckModule {}
