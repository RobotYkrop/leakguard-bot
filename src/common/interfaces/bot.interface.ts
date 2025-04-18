import { ParseMode } from 'telegraf/typings/core/types/typegram';

export interface IBot {
  sendMessage(
    chatId: number,
    message: string,
    options?: { parse_mode?: ParseMode },
  ): Promise<void>;
  sendProgressMessage(chatId: number, message: string): Promise<void>;
}
