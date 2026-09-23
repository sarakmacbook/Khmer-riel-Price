"use client";

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TrendingUp, TrendingDown, RefreshCw, Bell, Calculator, Sparkles, Send } from 'lucide-react';
import TelegramAlertModal from '@/components/TelegramAlertModal';
import PriceChart, { type ChartPoint } from '@/components/PriceChart';

type Range = 'day' | 'week' | 'month' | 'year' | 'all';
type Quote = { rate: number; bid: number; ask: number; checkedAt: string; storage?: 'database' | 'memory' };
type RateError = { error: string; hint?: string; kind?: string };

const RANGES: { key: Range; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
  { key: 'all', label: 'All' },
];

// How often the browser polls. The CDN caches /api/rate for 5s, so polling
// faster than that returns identical data. Override with NEXT_PUBLIC_POLL_SECONDS.
const POLL_MS = Math.max(1, Number(process.env.NEXT_PUBLIC_POLL_SECONDS) || 5) * 1000;
const HISTORY_POLL_MS = 60_000;

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/** Runs `fn` now, then every `ms` while the tab is visible (paused when hidden). */
function useVisiblePolling(fn: () => void, ms: number, deps: React.DependencyList) {
  useEffect(() => {
    fn();
    const id = setInterval(() => isVisible() && fn(), ms);
    const onVis = () => isVisible() && fn();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Small self-ticking label so the rest of the page doesn't re-render every second. */
function CheckedAgo({ at }: { at: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!at) return <>connecting…</>;
  const s = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  const ago = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  return <>checked {ago} ago</>;
}

export default function RateTracker() {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [rateError, setRateError] = useState<RateError | null>(null);
  const [fetchingFirst, setFetchingFirst] = useState(true);
  const [trend, setTrend] = useState<'up' | 'down' | 'stable'>('stable');
  const lastBidRef = useRef<number | null>(null);

  const [history, setHistory] = useState<ChartPoint[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [range, setRange] = useState<Range>('day');
  const [chartMetric, setChartMetric] = useState<'bid' | 'ask'>('bid');

  const [isNotifying, setIsNotifying] = useState(false);
  const [showTelegramModal, setShowTelegramModal] = useState(false);
  const [telegramAlertActive, setTelegramAlertActive] = useState(false);

  // ---- Tiny calculator ----
  // 'sell_ads' divides by Wing Bank ask (selling) price, 'buy_ads' by bid (buying) price
  const [calcSide, setCalcSide] = useState<'sell_ads' | 'buy_ads'>('sell_ads');
  const [calcAmount, setCalcAmount] = useState<string>('40');

  // ---- Data fetching ----
  const inFlight = useRef(false);
  const fetchRate = useCallback(async () => {
    if (inFlight.current) return; // the first fetch can take a while — don't stack requests
    inFlight.current = true;
    try {
      const res = await fetch('/api/rate');
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || typeof data.bid !== 'number') {
        setRateError(data?.error ? data : { error: `Server responded HTTP ${res.status}` });
        return;
      }
      const prev = lastBidRef.current;
      if (prev !== null && data.bid !== prev) setTrend(data.bid > prev ? 'up' : 'down');
      lastBidRef.current = data.bid;
      setQuote(data);
      setRateError(null);
    } catch {
      setRateError({ error: 'Network error — check your connection' });
    } finally {
      inFlight.current = false;
      setFetchingFirst(false);
    }
  }, []);

  const fetchHistory = useCallback(async (r: Range) => {
    try {
      const res = await fetch(`/api/rate/history?range=${r}`);
      const data = await res.json();
      if (Array.isArray(data)) setHistory(data);
    } catch {
      /* ignore */
    } finally {
      setHistoryLoaded(true);
    }
  }, []);

  const checkTelegramStatus = useCallback(() => {
    fetch('/api/telegram/settings')
      .then((res) => res.json())
      .then((data) => setTelegramAlertActive(Boolean(data.configured && data.active)))
      .catch(() => {});
  }, []);

  useVisiblePolling(fetchRate, POLL_MS, []);
  useVisiblePolling(() => fetchHistory(range), HISTORY_POLL_MS, [range]);
  useEffect(checkTelegramStatus, [checkTelegramStatus]);

  const requestNotificationPermission = async () => {
    if (typeof Notification === 'undefined') return;
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setIsNotifying(true);
      new Notification('WingRate', {
        body: "Notifications enabled! We'll keep you updated on KHR/USD rates.",
        icon: '/icons/icon-192x192.png',
      });
    }
  };

  const rate = quote?.rate ?? null;
  const bid = quote?.bid ?? null;
  const ask = quote?.ask ?? null;

  // ---- Tiny calculator math ----
  const calcPrice = (calcSide === 'sell_ads' ? ask : bid) ?? rate ?? 0;
  const enterAmount = parseFloat(calcAmount.replace(/,/g, '')) || 0;
  const calcResult = calcPrice > 0 ? enterAmount / calcPrice : 0;

  const onAmountChange = (raw: string) => {
    let v = raw.replace(/[^\d.]/g, '');
    const parts = v.split('.');
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
    setCalcAmount(v);
  };
  const displayAmount = calcAmount ? calcAmount.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';

  // ---- Chart formatters (stable so the memoized chart doesn't re-render) ----
  const formatTick = useCallback(
    (t: number) => {
      const d = new Date(t);
      if (range === 'day') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (range === 'week' || range === 'month') return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
    },
    [range],
  );
  const formatLabel = useCallback(
    (t: number) => {
      const d = new Date(t);
      return range === 'day'
        ? d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    },
    [range],
  );

  const pill = (active: boolean) =>
    `py-1.5 text-xs font-semibold rounded-lg transition-all ${
      active ? 'bg-indigo-500 text-white shadow' : 'text-slate-400 hover:text-slate-200'
    }`;

  return (
    <div className="min-h-screen text-slate-100 font-sans">
      {/* Header */}
      <header className="bg-white/5 backdrop-blur-xl border-b border-white/10 sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="bg-indigo-500 p-2 rounded-xl shadow-lg shadow-indigo-500/30">
              <TrendingUp className="h-5 w-5 text-white" />
            </div>
            <h1 className="text-xl font-black tracking-tight text-white">
              Wing<span className="text-indigo-400">Rate</span>
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setShowTelegramModal(true)}
              className="relative p-2 rounded-full transition-colors text-slate-400 hover:text-indigo-400 hover:bg-white/10"
              title="Telegram Webhook Alerts"
            >
              <Send className="h-5 w-5" />
              {telegramAlertActive && (
                <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
              )}
            </button>
            <button
              onClick={requestNotificationPermission}
              className={`p-2 rounded-full transition-colors ${
                isNotifying ? 'text-indigo-400' : 'text-slate-400 hover:bg-white/10'
              }`}
              title="Enable Browser Notifications"
            >
              <Bell className="h-6 w-6" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {/* Hero Rate Display */}
        <div className="relative overflow-hidden rounded-3xl p-8 mb-8 text-center border border-white/10 bg-slate-900/70 backdrop-blur-xl shadow-2xl">
          <div className="pointer-events-none absolute -top-20 -right-20 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-24 -left-16 h-64 w-64 rounded-full bg-indigo-500/10 blur-3xl" />

          <h2 className="relative text-slate-400 text-sm font-medium uppercase tracking-[0.2em] mb-3">
            USD / KHR Exchange Rate
          </h2>
          <div className="relative flex items-center justify-center gap-4 mb-5">
            <span className="text-6xl md:text-8xl font-black tabular-nums text-white drop-shadow-[0_0_25px_rgba(99,102,241,0.4)]">
              {rate ? rate.toLocaleString() : '---'}
            </span>
            <div
              className={`flex items-center justify-center p-2.5 rounded-2xl ${
                trend === 'up'
                  ? 'bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-500/30'
                  : trend === 'down'
                    ? 'bg-indigo-500/10 text-indigo-400/70 ring-1 ring-indigo-500/20'
                    : 'bg-white/5 text-slate-400 ring-1 ring-white/10'
              }`}
            >
              {trend === 'up' ? (
                <TrendingUp className="h-6 w-6" />
              ) : trend === 'down' ? (
                <TrendingDown className="h-6 w-6" />
              ) : (
                <RefreshCw className="h-6 w-6" />
              )}
            </div>
          </div>

          <div className="relative flex items-center justify-center gap-3 flex-wrap text-sm">
            <span className="rounded-xl px-3.5 py-1.5 tabular-nums bg-white/5 border border-white/10 text-slate-300">
              Bank buys USD{' '}
              <span className="font-bold text-indigo-300">{bid ? bid.toLocaleString() : '—'}</span>
            </span>
            <span className="rounded-xl px-3.5 py-1.5 tabular-nums bg-white/5 border border-white/10 text-slate-300">
              Bank sells USD{' '}
              <span className="font-bold text-indigo-300">{ask ? ask.toLocaleString() : '—'}</span>
            </span>
          </div>

          {quote && (
            <p className="relative text-slate-500 text-xs mt-4 flex items-center justify-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${rateError ? 'bg-slate-500' : 'bg-indigo-400 animate-pulse-glow'}`} />
              Live from Wing Bank · <CheckedAgo at={quote.checkedAt} />
              {rateError && <span className="text-slate-400">· retrying…</span>}
            </p>
          )}

          {!quote && fetchingFirst && (
            <p className="relative text-slate-400 text-xs mt-4 flex items-center justify-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-indigo-400" />
              Fetching the rate from Wing Bank… (their site can take up to 30s)
            </p>
          )}

          {!quote && rateError && (
            <div className="relative mt-5 mx-auto max-w-md rounded-2xl border border-white/10 bg-black/30 p-4 text-left text-xs">
              <p className="font-semibold text-slate-200">Can&apos;t get the rate right now — retrying automatically</p>
              <p className="mt-1 text-slate-400">{rateError.error}</p>
              {rateError.hint && <p className="mt-1 text-indigo-300/90">{rateError.hint}</p>}
              <a href="/api/status?check=1" target="_blank" rel="noreferrer" className="mt-2 inline-block text-indigo-400 underline underline-offset-2">
                Open diagnostics
              </a>
            </div>
          )}
        </div>

        {/* ---- Tiny calculator ---- */}
        <div className="rounded-3xl p-5 mb-8 border border-white/10 bg-slate-900/60 backdrop-blur-xl shadow-xl">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Calculator className="h-4 w-4 text-indigo-400" />
              <span className="text-sm font-semibold text-slate-200">Tiny Calculator</span>
            </div>
            <div className="flex p-1 bg-black/30 rounded-xl text-xs font-bold ring-1 ring-white/10">
              <button onClick={() => setCalcSide('sell_ads')} className={`px-4 ${pill(calcSide === 'sell_ads')}`}>
                Sell Ads
              </button>
              <button onClick={() => setCalcSide('buy_ads')} className={`px-4 ${pill(calcSide === 'buy_ads')}`}>
                Buy Ads
              </button>
            </div>
          </div>

          <p className="text-sm font-semibold mb-4 text-indigo-300">Input Unit Price USDT</p>

          <div className="flex flex-col sm:flex-row gap-3 items-stretch">
            <div className="flex-1 flex items-center bg-black/30 border border-white/10 rounded-xl focus-within:ring-2 focus-within:ring-indigo-500 transition-all">
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={displayAmount}
                onChange={(e) => onAmountChange(e.target.value)}
                className="flex-1 min-w-0 bg-transparent px-4 py-3 text-white tabular-nums outline-none"
                placeholder="Enter amount"
              />
              <span className="px-4 text-sm font-bold text-indigo-300 border-l border-white/10">KHR</span>
            </div>
            <div className="rounded-xl px-4 py-3 text-center min-w-[190px] border border-indigo-500/30 bg-indigo-500/5">
              <div className="text-2xl font-black text-white tabular-nums leading-none">{calcResult.toFixed(5)}</div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-1">USDT</div>
            </div>
          </div>
        </div>

        {/* Graph Section */}
        <div className="rounded-3xl p-6 mb-8 border border-white/10 bg-slate-900/60 backdrop-blur-xl shadow-xl">
          <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-200">Price History</h3>
              <p className="text-xs text-indigo-300/80">
                {chartMetric === 'ask' ? 'Bank Sells (Ask)' : 'Bank Buys (Bid)'} ·{' '}
                {range === 'day' ? 'Last 24 hours' : 'Daily Snapshot'}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex p-1 bg-black/30 rounded-xl ring-1 ring-white/10">
                <button onClick={() => setChartMetric('bid')} className={`px-3 ${pill(chartMetric === 'bid')}`}>
                  Buy (Bid)
                </button>
                <button onClick={() => setChartMetric('ask')} className={`px-3 ${pill(chartMetric === 'ask')}`}>
                  Sell (Ask)
                </button>
              </div>
              <div className="flex p-1 bg-black/30 rounded-xl ring-1 ring-white/10">
                {RANGES.map((r) => (
                  <button key={r.key} onClick={() => setRange(r.key)} className={`px-2.5 ${pill(range === r.key)}`}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {history.length === 0 ? (
            <div className="h-72 flex items-center justify-center text-slate-500 text-sm">
              {!historyLoaded
                ? 'Loading…'
                : quote?.storage === 'memory'
                  ? 'Price history needs storage — connect any Vercel database (Neon, Supabase, Upstash, Turso, MongoDB, Blob…) to start recording.'
                  : 'No data for this range yet — history builds up automatically.'}
            </div>
          ) : (
            <PriceChart
              points={history}
              metric={chartMetric}
              step={range === 'day'}
              seriesLabel={chartMetric === 'ask' ? 'Bank Sells (Ask)' : 'Bank Buys (Bid)'}
              formatTick={formatTick}
              formatLabel={formatLabel}
            />
          )}
        </div>

        {/* PWA Info */}
        <div className="rounded-2xl p-6 border border-indigo-500/20 bg-indigo-500/10 text-center">
          <p className="text-indigo-200 text-sm font-medium">
            💡 Add this app to your home screen for a native-like experience and instant notifications!
          </p>
        </div>

        {/* Credit */}
        <footer className="mt-8 text-center">
          <div className="inline-flex items-center gap-2 text-xs text-slate-400 bg-white/5 border border-white/10 rounded-full px-4 py-2">
            <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            Built with <span className="text-indigo-300 font-semibold">Claude Sonnet 4.5</span>
            <span className="text-slate-600">·</span>
            <span>by Anthropic</span>
          </div>
          <p className="text-[10px] text-slate-600 mt-3">Data source: wingbank.com.kh · Not financial advice</p>
        </footer>
      </main>

      <TelegramAlertModal
        isOpen={showTelegramModal}
        onClose={() => {
          setShowTelegramModal(false);
          checkTelegramStatus();
        }}
        currentBid={bid}
        currentAsk={ask}
      />
    </div>
  );
}
