// src/modules/puppeteer/puppeteer.module.ts
import { Module } from '@nestjs/common';
import { PuppeteerService } from './puppeteer.service';

@Module({
  providers: [PuppeteerService],
  exports: [PuppeteerService],
})
export class PuppeteerModule {}
