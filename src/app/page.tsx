"use client";

import React, { useState, useEffect } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { TrendingUp, TrendingDown, RefreshCw, Bell, Calculator, Sparkles, Send } from 'lucide-react';
import TelegramAlertModal from '@/components/TelegramAlertModal';

type Range = 'day' | 'week' | 'month' | 'year' | 'all';

const RANGES: { key: Range; label: string }[] = [
  { key: 'day', label: 'Day' },
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year', label: 'Year' },
  { key: 'all', label: 'All' },
];

export default function RateTracker() {
  const [rate, setRate] = useState<number | null>(null);
  const [bid, setBid] = useState<number | null>(null);
  const [ask, setAsk] = useState<number | null>(null);
  const [prevRate, setPrevRate] = useState<number | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [range, setRange] = useState<Range>('day');
  const [chartMetric, setChartMetric] = useState<'bid' | 'ask'>('bid');
  const [loading, setLoading] = useState(true);
  const [isNotifying, setIsNotifying] = useState(false);
  const [showTelegramModal, setShowTelegramModal] = useState(false);
  const [telegramAlertActive, setTelegramAlertActive] = useState(false);

  // Check if Telegram alerts are active
  const checkTelegramStatus = () => {
    fetch('/api/telegram/settings')
      .then((res) => res.json())
      .then((data) => {
        if (data.configured && data.active) {
          setTelegramAlertActive(true);
        } else {
          setTelegramAlertActive(false);
        }
      })
      .catch(() => {});
  };

  useEffect(() => {
    checkTelegramStatus();
  }, []);

  // ---- Tiny calculator ----
  // 'sell_ads' = former Buy USDT (divides by wing bank ask/selling price)
  // 'buy_ads' = former Sell USDT (divides by wing bank bid/buying price)
  const [calcSide, setCalcSide] = useState<'sell_ads' | 'buy_ads'>('sell_ads');
  // Initialized to 40 so when the site opens, it starts at 40 KHR immediately
  const [calcAmount, setCalcAmount] = useState<string>('40');

  const fetchRate = async () => {
    try {
      const res = await fetch('/api/rate');
      const data = await res.json();
      if (data.rate) {
        setPrevRate(rate);
        setRate(data.rate);
        setBid(data.bid);
        setAsk(data.ask);
      }
    } catch (error) {
      console.error('Error fetching rate:', error);
    }
  };

  const fetchHistory = async (r: Range) => {
    try {
      const res = await fetch(`/api/rate/history?range=${r}`);
      const data = await res.json();
      if (Array.isArray(data)) setHistory(data);
    } catch (error) {
      console.error('Error fetching history:', error);
    }
  };

  useEffect(() => {
    fetchRate();
    setLoading(false);

    const rateInterval = setInterval(fetchRate, 1000);
    return () => clearInterval(rateInterval);
  }, []);

  useEffect(() => {
    fetchHistory(range);
    const historyInterval = setInterval(() => fetchHistory(range), 30000);
    return () => clearInterval(historyInterval);
  }, [range]);

  const requestNotificationPermission = async () => {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setIsNotifying(true);
      new Notification('WingRate', {
        body: "Notifications enabled! We'll keep you updated on KHR/USD rates.",
        icon: '/icons/icon-192x192.png',
      });
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <RefreshCw className="h-12 w-12 animate-spin text-indigo-400" />
      </div>
    );
  }

  const trend =
    rate && prevRate ? (rate > prevRate ? 'up' : rate < prevRate ? 'down' : 'stable') : 'stable';

  // ---- Tiny calculator math ----
  const wingAsk = ask ?? rate ?? 0;
  const wingBid = bid ?? rate ?? 0;
  const calcPrice = calcSide === 'sell_ads' ? wingAsk : wingBid;

  // Parse the KHR amount safely (accepts "4000", "4,000", "4 000", "4000.5")
  const enterAmount = parseFloat(calcAmount.replace(/,/g, '')) || 0;
  const calcResult = calcPrice > 0 ? enterAmount / calcPrice : 0;

  // Keep only digits + one decimal point while typing
  const onAmountChange = (raw: string) => {
    let v = raw.replace(/[^\d.]/g, '');
    const parts = v.split('.');
    if (parts.length > 2) v = parts[0] + '.' + parts.slice(1).join('');
    setCalcAmount(v);
  };

  // Display the KHR amount grouped: "4,000" (keeps raw input stable while typing)
  const displayAmount = calcAmount
    ? calcAmount.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : '';

  const fmtTick = (value: any) => {
    if (!value) return '';
    const d = new Date(value as string);
    if (range === 'day') return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (range === 'week' || range === 'month')
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return d.toLocaleDateString([], { month: 'short', year: '2-digit' });
  };

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

          {/* Wing Bank counter rates */}
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

          <p className="relative text-slate-500 text-xs mt-4 flex items-center justify-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-indigo-400 animate-pulse-glow" />
            Live from Wing Bank · updates every second
          </p>
        </div>

        {/* ---- Tiny calculator ---- */}
        <div className="rounded-3xl p-5 mb-8 border border-white/10 bg-slate-900/60 backdrop-blur-xl shadow-xl">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Calculator className="h-4 w-4 text-indigo-400" />
              <span className="text-sm font-semibold text-slate-200">Tiny Calculator</span>
            </div>
            <div className="flex p-1 bg-black/30 rounded-xl text-xs font-bold ring-1 ring-white/10">
              <button
                onClick={() => setCalcSide('sell_ads')}
                className={`px-4 py-1.5 rounded-lg transition-all ${
                  calcSide === 'sell_ads'
                    ? 'bg-indigo-500 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Sell Ads
              </button>
              <button
                onClick={() => setCalcSide('buy_ads')}
                className={`px-4 py-1.5 rounded-lg transition-all ${
                  calcSide === 'buy_ads'
                    ? 'bg-indigo-500 text-white shadow'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Buy Ads
              </button>
            </div>
          </div>

          <p className="text-sm font-semibold mb-4 text-indigo-300">
            Input Unit Price USDT
          </p>

          <div className="flex flex-col sm:flex-row gap-3 items-stretch">
            <div className="flex-1 flex items-center bg-black/30 border border-white/10 rounded-xl focus-within:ring-2 focus-within:ring-indigo-500 transition-all">
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={displayAmount}
                onChange={(e) => onAmountChange(e.target.value)}
                className="flex-1 bg-transparent px-4 py-3 text-white tabular-nums outline-none"
                placeholder="Enter amount"
              />
              <span className="px-4 text-sm font-bold text-indigo-300 border-l border-white/10">
                KHR
              </span>
            </div>
            <div className="rounded-xl px-4 py-3 text-center min-w-[190px] border border-indigo-500/30 bg-indigo-500/5">
              <div className="text-2xl font-black text-white tabular-nums leading-none">
                {calcResult.toFixed(5)}
              </div>
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-1">
                USDT
              </div>
            </div>
          </div>
        </div>

        {/* Graph Section */}
        <div className="rounded-3xl p-6 mb-8 border border-white/10 bg-slate-900/60 backdrop-blur-xl shadow-xl">
          <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
            <div>
              <h3 className="text-lg font-semibold text-slate-200">Price History</h3>
              <p className="text-xs text-indigo-300/80">
                {chartMetric === 'ask' ? 'Bank Sells (Ask)' : 'Bank Buys (Bid)'} · Daily Snapshot
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Metric switcher: Buy (Bid) vs Sell (Ask) */}
              <div className="flex p-1 bg-black/30 rounded-xl ring-1 ring-white/10">
                <button
                  onClick={() => setChartMetric('bid')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                    chartMetric === 'bid'
                      ? 'bg-indigo-500 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Buy (Bid)
                </button>
                <button
                  onClick={() => setChartMetric('ask')}
                  className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                    chartMetric === 'ask'
                      ? 'bg-indigo-500 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Sell (Ask)
                </button>
              </div>

              {/* Time Range pills */}
              <div className="flex p-1 bg-black/30 rounded-xl ring-1 ring-white/10">
                {RANGES.map((r) => (
                  <button
                    key={r.key}
                    onClick={() => setRange(r.key)}
                    className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                      range === r.key
                        ? 'bg-indigo-500 text-white shadow'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="h-72 w-full">
            {history.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500 text-sm">
                Loading daily snapshot data...
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={history}>
                  <defs>
                    <linearGradient id="rateFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity={0.45} />
                      <stop offset="70%" stopColor="#6366f1" stopOpacity={0.12} />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="rgba(255,255,255,0.06)"
                  />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={fmtTick}
                    tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={40}
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    orientation="right"
                    tick={{ fontSize: 12, fill: '#64748b' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'rgba(10,10,15,0.95)',
                      borderColor: 'rgba(255,255,255,0.12)',
                      borderRadius: '12px',
                      color: '#f8fafc',
                      backdropFilter: 'blur(8px)',
                    }}
                    itemStyle={{ color: '#a5b4fc' }}
                    formatter={(val: any) => [
                      `${Number(val).toLocaleString()} KHR`,
                      chartMetric === 'ask' ? 'Bank Sells (Ask)' : 'Bank Buys (Bid)',
                    ]}
                    labelFormatter={(value) => {
                      if (!value) return '';
                      const d = new Date(value as string);
                      return range === 'day'
                        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        : d.toLocaleDateString([], {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          });
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey={chartMetric}
                    stroke="#818cf8"
                    strokeWidth={3}
                    fill="url(#rateFill)"
                    dot={false}
                    animationDuration={400}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* PWA Info */}
        <div className="rounded-2xl p-6 border border-indigo-500/20 bg-indigo-500/10 text-center">
          <p className="text-indigo-200 text-sm font-medium">
            💡 Add this app to your home screen for a native-like experience and instant
            notifications!
          </p>
        </div>

        {/* Credit */}
        <footer className="mt-8 text-center">
          <div className="inline-flex items-center gap-2 text-xs text-slate-400 bg-white/5 border border-white/10 rounded-full px-4 py-2">
            <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            Built with{' '}
            <span className="text-indigo-300 font-semibold">Claude Sonnet 4.5</span>
            <span className="text-slate-600">·</span>
            <span>by Anthropic</span>
          </div>
          <p className="text-[10px] text-slate-600 mt-3">
            Data source: wingbank.com.kh · Not financial advice
          </p>
        </footer>
      </main>

      {/* Telegram Alert Webhook Modal */}
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
