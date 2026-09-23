import * as cheerio from 'cheerio';

export interface WingBankQuote {
  /** Bank buys USD from you (Bid) — baseline when you SELL USDT for KHR */
  bid: number;
  /** Bank sells USD to you (Ask) — baseline when you BUY USDT with KHR */
  ask: number;
  /** Displayed reference rate (bid) */
  rate: number;
  fetchedAt: string;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Both URL variants (Wing Bank redirects between them) + Vercel serverless
// has no long-hung fetch tolerance, so every attempt is time-boxed.
const WING_URLS = [
  'https://www.wingbank.com.kh/en/exchange-rate/',
  'https://www.wingbank.com.kh/en/exchange-rate',
];

const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 9_500;
let cache: { quote: WingBankQuote; at: number } | null = null;

/** Warm cache accessor used by routes that want to avoid a slow scrape. */
export function getFreshQuote(): WingBankQuote | null {
  return cache && Date.now() - cache.at < CACHE_TTL_MS ? cache.quote : null;
}

function parseWingBankHtml(html: string): WingBankQuote | null {
  const $ = cheerio.load(html);
  let bid: number | null = null;
  let ask: number | null = null;

  // USD/KHR row: [bank+pair] [pair] [Bid: 1 USD] [Ask: 1 USD]
  $('tr').each((_, tr) => {
    if (bid !== null && ask !== null) return false;
    const cells = $(tr).find('td');
    const texts = cells
      .map((__, td) => $(td).text().replace(/\s+/g, ' ').trim())
      .get();

    const isUsdKhr = texts.some((t) => t === 'USD/KHR' || t.includes('USD/KHR'));
    if (!isUsdKhr || texts.length < 4) return;

    const b = parseFloat(texts[2].replace(/[^\d.]/g, ''));
    const a = parseFloat(texts[3].replace(/[^\d.]/g, ''));
    if (!isNaN(b) && !isNaN(a) && b > 0 && a > 0) {
      bid = Math.min(b, a);
      ask = Math.max(b, a);
    }
  });

  if (bid === null || ask === null) {
    // Fallback: any cell containing USD/KHR followed by numeric cells
    const flat = html.replace(/\s+/g, ' ');
    const row = flat.match(/Cambodian Riel[\s\S]{0,400}?USD\/KHR[\s\S]{0,400}?<\/tr>/i);
    if (row) {
      const nums = [...row[0].matchAll(/<td[^>]*>\s*(?:<span[^>]*>)?\s*([\d,]+(?:\.\d+)?)\s*</gi)]
        .map((m) => Number(m[1].replace(/,/g, '')))
        .filter((n) => Number.isFinite(n) && n > 1000 && n < 10000);
      if (nums.length >= 2) {
        bid = Math.min(nums[0], nums[1]);
        ask = Math.max(nums[0], nums[1]);
      }
    }
  }

  if (bid === null || ask === null) return null;
  return { bid, ask, rate: bid, fetchedAt: new Date().toISOString() };
}

/**
 * Scraper with timeout, dual-URL fallback and a short cache so 1s client
 * polling never hammers the bank site (and never hangs a serverless function).
 */
export async function fetchWingBankQuote(): Promise<WingBankQuote> {
  const fresh = getFreshQuote();
  if (fresh) return fresh;

  async function attempt(url: string): Promise<WingBankQuote> {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Wing Bank HTTP ${response.status}`);
    const quote = parseWingBankHtml(await response.text());
    if (!quote) throw new Error('USD/KHR not found in Wing Bank page');
    return quote;
  }

  // Race both URL variants in parallel — first valid parse wins, so a slow
  // redirect or a blocked path cannot stall a serverless function.
  const results = await Promise.allSettled(WING_URLS.map(attempt));
  const winner = results.find(
    (r): r is PromiseFulfilledResult<WingBankQuote> => r.status === 'fulfilled',
  );

  if (winner) {
    cache = { quote: winner.value, at: Date.now() };
    return winner.value;
  }

  const lastError =
    results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason ??
    new Error('Wing Bank scrape failed');

  // Serve the last known good quote so the dashboard keeps living
  if (cache) return cache.quote;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Backwards-compatible helper: returns the bank bid (USD/KHR) */
export async function fetchWingBankRate(): Promise<number> {
  const q = await fetchWingBankQuote();
  return q.rate;
}
