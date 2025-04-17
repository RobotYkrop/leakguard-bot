# Используем официальный образ Node.js 20 (LTS) на основе Alpine для минимизации размера
FROM node:20-alpine

# Устанавливаем системные зависимости для Puppeteer/Chromium
RUN apk add --no-cache \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont \
  nodejs \
  yarn

# Устанавливаем переменную окружения для Puppeteer, чтобы использовать установленный Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Создаём рабочую директорию
WORKDIR /app

# Копируем package.json и yarn.lock (если используется yarn) для кэширования зависимостей
COPY package.json yarn.lock* ./

# Устанавливаем зависимости
RUN npm install --legacy-peer-deps

# Копируем весь проект
COPY . .

# Собираем приложение
RUN npm run build

# Открываем порт 3000
EXPOSE 3000

# Запускаем приложение в продакшен-режиме
CMD ["npm", "run", "start:prod"]