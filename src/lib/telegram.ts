export interface SendTelegramAlertParams {
  webhookUrl?: string | null;
  botToken?: string | null;
  chatId?: string | null;
  text: string;
}

export async function sendTelegramWebhookAlert(params: SendTelegramAlertParams): Promise<{ success: boolean; error?: string }> {
  const { webhookUrl, botToken, chatId, text } = params;

  // 1. Direct Telegram Bot API call via botToken + chatId
  const token = botToken || process.env.TELEGRAM_BOT_TOKEN;
  if (token && chatId) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId.trim(),
          text: text,
          parse_mode: 'HTML',
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        return { success: false, error: data.description || `Telegram API error: ${res.status}` };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to call Telegram API' };
    }
  }

  // 2. Custom Webhook URL
  if (webhookUrl && webhookUrl.trim().length > 0) {
    const url = webhookUrl.trim();
    try {
      // If it's a telegram bot API URL
      if (url.includes('api.telegram.org')) {
        const body: Record<string, any> = { text, parse_mode: 'HTML' };
        if (chatId) body.chat_id = chatId.trim();

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok || (data && data.ok === false)) {
          return { success: false, error: data?.description || `Webhook HTTP ${res.status}` };
        }
        return { success: true };
      }

      // Generic webhook (supports Zapier, Make, custom relay)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          message: text,
          content: text,
          chat_id: chatId,
          timestamp: new Date().toISOString(),
        }),
      });

      if (!res.ok) {
        return { success: false, error: `Webhook returned status ${res.status}` };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Failed to call Webhook URL' };
    }
  }

  return { success: false, error: 'Provide a Telegram Webhook URL or Bot Token + Chat ID' };
}
