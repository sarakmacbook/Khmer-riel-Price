import * as cheerio from 'cheerio';

export interface WingBankQuote {
  /** Bank buys USD from you (Bid) — the rate that matters when you SELL USDT for KHR */
  bid: number;
  /** Bank sells USD to you (Ask) — the rate that matters when you BUY USDT with KHR */
  ask: number;
  /** Displayed reference rate (same as bid historically in this app) */
  rate: number;
}

export async function fetchWingBankQuote(): Promise<WingBankQuote> {
  try {
    const response = await fetch('https://www.wingbank.com.kh/en/exchange-rate', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Wing Bank page: ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    let bid: number | null = null;
    let ask: number | null = null;

    // The USD/KHR row layout: [bank name + pair] [pair] [Bid: 1 USD] [Ask: 1 USD]
    $('tr').each((_, tr) => {
      if (bid !== null && ask !== null) return;
      const cells = $(tr).find('td');
      const texts = cells
        .map((__, td) =>
          $(td)
            .text()
            .replace(/\s+/g, ' ')
            .trim(),
        )
        .get();

      const isUsdKhr = texts.some((t) => t === 'USD/KHR' || t.includes('USD/KHR'));
      if (!isUsdKhr || texts.length < 4) return;

      const b = parseFloat(texts[2].replace(/[^\d.]/g, ''));
      const a = parseFloat(texts[3].replace(/[^\d.]/g, ''));
      if (!isNaN(b) && !isNaN(a) && b > 0 && a > 0) {
        bid = b;
        ask = a;
      }
    });

    if (bid === null || ask === null) {
      // Fallback to the old single-value parse so tracking never breaks
      const rateText = $('td:contains("USD/KHR")').next('td').find('.font-medium').first().text();
      const fallback = parseFloat(rateText.replace(/[^\d.]/g, ''));
      if (isNaN(fallback)) throw new Error('Could not find USD/KHR rate on the page');
      bid = fallback;
      ask = fallback;
    }

    return { bid, ask, rate: bid };
  } catch (error) {
    console.error('Error scraping Wing Bank rate:', error);
    throw error;
  }
}

/** Backwards-compatible helper: returns the bank bid (USD/KHR) */
export async function fetchWingBankRate(): Promise<number> {
  const q = await fetchWingBankQuote();
  return q.rate;
}
