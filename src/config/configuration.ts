import { registerAs } from '@nestjs/config';
import Joi from 'joi';

export default registerAs('app', () => {
  const env = process.env;
  return {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    redisHost: env.REDIS_HOST || 'localhost',
    redisPort: env.REDIS_PORT || 6379,
    redisPassword: env.REDIS_PASSWORD || '',
    redisTls: env.REDIS_TLS === 'true',
    leakCheckApiUrl: env.LEAKCHECK_API_URL || 'https://leakcheck.io/api/public',
    xposedOrNotApiUrl:
      env.XPOSED_OR_NOT_API_URL || 'https://api.xposedornot.com/v1',
  };
});

export const configValidationSchema = Joi.object({
  TELEGRAM_BOT_TOKEN: Joi.string().required(),
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
});
