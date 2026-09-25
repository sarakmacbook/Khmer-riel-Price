import { pgTable, serial, numeric, timestamp, text, boolean } from 'drizzle-orm/pg-core';

export const exchangeRates = pgTable('exchange_rates', {
  id: serial('id').primaryKey(),
  rate: numeric('rate', { precision: 12, scale: 4 }).notNull(),
  /** Wing Bank Bid: bank buys 1 USD from you (used when you SELL USDT) */
  bid: numeric('bid', { precision: 12, scale: 4 }),
  /** Wing Bank Ask: bank sells 1 USD to you (used when you BUY USDT) */
  ask: numeric('ask', { precision: 12, scale: 4 }),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  /** Last time this price was confirmed unchanged (see PostgresStore.record) */
  checkedAt: timestamp('checked_at'),
});

export const telegramAlerts = pgTable('telegram_alerts', {
  id: serial('id').primaryKey(),
  /** Where the alert was created: 'web' (dashboard) or 'bot' (Telegram) */
  source: text('source').default('web').notNull(),
  webhookUrl: text('webhook_url'),
  chatId: text('chat_id'),
  botToken: text('bot_token'),
  condition: text('condition').default('change').notNull(), // 'change' | 'above' | 'below'
  targetRate: numeric('target_rate', { precision: 12, scale: 4 }),
  /** Optional custom alert message template ({bid} {ask} {diff} {arrow} {time} {link}). Null = default. */
  customMessage: text('custom_message'),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastAlertAt: timestamp('last_alert_at'),
});
