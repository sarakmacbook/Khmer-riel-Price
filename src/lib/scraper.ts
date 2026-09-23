// Dependency-free Wing Bank scraper.
// Wing Bank has no public JSON API: rates are in a ~590 KB server-rendered page
// (~20 KB with brotli) behind an F5 web firewall. We request compression,
// stream the body, and stop as soon as the USD/KHR row has arrived.

export interface WingBankQuote {
  /** Bank buys USD from you (Bid) */
  bid: number;
  /** Bank sells USD to you (Ask) */
  ask: number;
  /** Displayed reference rate (= bid) */
  rate: number;
}

export class ScrapeError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'blocked' | 'http' | 'layout' | 'network',
  ) {
    super(message);
    this.name = 'ScrapeError';
  }
}

// Override with a comma-separated list, e.g. a proxy that returns the same HTML.
const SOURCE_URLS = (
  process.env.WINGBANK_URL ||
  'https://www.wingbank.com.kh/en/exchange-rate,https://www.wingbank.com.kh/km/exchange-rate'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Wing Bank can take 5–15s before the first byte; the body then arrives in ~30ms.
const TOTAL_BUDGET_MS = Number(process.env.SCRAPE_TIMEOUT_MS) || 45_000;

const HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,km;q=0.8',
  'Accept-Encoding': 'br, gzip, deflate',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
};

const cellText = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const toNumber = (s: string) => parseFloat(s.replace(/,/g, '').replace(/[^\d.]/g, ''));

/** Find the USD/KHR row: [bank name + pair] [pair] [Bid: 1 USD] [Ask: 1 USD] */
export function parseQuote(html: string): WingBankQuote | null {
  let from = 0;
  for (;;) {
    const hit = html.indexOf('USD/KHR', from);
    if (hit === -1) return null;
    from = hit + 7;

    const start = html.lastIndexOf('<tr', hit);
    const end = html.indexOf('</tr>', hit);
    if (start === -1 || end === -1) continue; // row not complete yet

    const cells = [...html.slice(start, end).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    if (cells.length < 4) continue;

    const bid = toNumber(cells[2]);
    const ask = toNumber(cells[3]);
    // Sanity check so a layout change can never store garbage
    if (bid > 3000 && bid < 6000 && ask >= bid && ask < 6000) return { bid, ask, rate: bid };
  }
}

const BLOCK_MARKERS = /request rejected|requested url was rejected|access denied|support id is|captcha|are you a robot|attention required/i;

async function fetchOnce(url: string, timeoutMs: number): Promise<WingBankQuote> {
  let res: Response;
  try {
    res = await fetch(url, { headers: HEADERS, cache: 'no-store', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new ScrapeError(`Wing Bank did not respond within ${Math.round(timeoutMs / 1000)}s`, 'timeout');
    }
    throw new ScrapeError(`Network error reaching Wing Bank: ${err.message}`, 'network');
  }

  if (res.status === 403 || res.status === 429) {
    throw new ScrapeError(`Wing Bank's firewall blocked this server (HTTP ${res.status})`, 'blocked');
  }
  if (!res.ok || !res.body) throw new ScrapeError(`Wing Bank responded HTTP ${res.status}`, 'http');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) html += decoder.decode(value, { stream: true });
    if (html.includes('USD/KHR')) {
      const quote = parseQuote(html);
      if (quote) {
        reader.cancel().catch(() => {}); // stop downloading the rest of the page
        return quote;
      }
    }
    if (done) break;
  }

  if (html.length < 20_000 && BLOCK_MARKERS.test(html)) {
    throw new ScrapeError("Wing Bank's firewall rejected this server's IP (common for cloud hosts)", 'blocked');
  }
  throw new ScrapeError('USD/KHR row not found — Wing Bank page layout may have changed', 'layout');
}

/** Try each source URL in turn within one overall time budget. */
export async function fetchWingBankQuote(): Promise<WingBankQuote> {
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let lastError: ScrapeError | null = null;

  for (let i = 0; i < SOURCE_URLS.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining < 3_000) break;
    // Leave time for the fallback URL unless this is the last one
    const slice = i < SOURCE_URLS.length - 1 ? Math.min(remaining, Math.max(15_000, remaining * 0.6)) : remaining;
    try {
      return await fetchOnce(SOURCE_URLS[i], slice);
    } catch (e) {
      lastError = e instanceof ScrapeError ? e : new ScrapeError((e as Error).message, 'network');
      console.error(`[scraper] ${SOURCE_URLS[i]}: ${lastError.message}`);
    }
  }
  throw lastError ?? new ScrapeError('Wing Bank did not respond in time', 'timeout');
}
