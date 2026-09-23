import { pgTable, serial, numeric, timestamp, text, boolean, index } from 'drizzle-orm/pg-core';

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: serial('id').primaryKey(),
    rate: numeric('rate', { precision: 12, scale: 4 }).notNull(),
    /** Wing Bank Bid: bank buys 1 USD from you (used when you SELL USDT) */
    bid: numeric('bid', { precision: 12, scale: 4 }),
    /** Wing Bank Ask: bank sells 1 USD to you (used when you BUY USDT) */
    ask: numeric('ask', { precision: 12, scale: 4 }),
    /** When a price row was first recorded (a new row is only written when the price changes) */
    timestamp: timestamp('timestamp').defaultNow().notNull(),
    /** Last time Wing Bank was checked and still showed this price */
    checkedAt: timestamp('checked_at'),
  },
  (t) => [index('exchange_rates_timestamp_idx').on(t.timestamp)],
);

export const telegramAlerts = pgTable('telegram_alerts', {
  id: serial('id').primaryKey(),
  /** 'web' = configured on the website, 'bot' = subscribed via Telegram /alert */
  source: text('source').default('web').notNull(),
  webhookUrl: text('webhook_url'),
  chatId: text('chat_id'),
  botToken: text('bot_token'),
  condition: text('condition').default('change').notNull(), // 'change' | 'above' | 'below'
  targetRate: numeric('target_rate', { precision: 12, scale: 4 }),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  lastAlertAt: timestamp('last_alert_at'),
});
