"use client";

import React, { useState, useEffect } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

type Range = "day" | "week" | "month" | "year" | "all";

const RANGES: { key: Range; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "all", label: "All" },
];

/**
 * Self-contained price-history chart.
 * Owns its range/metric state and data fetching, and is loaded lazily from
 * the page (`next/dynamic`) so the Recharts bundle never blocks first paint —
 * which keeps the initial JS payload small on Vercel.
 */
export default function PriceHistoryChart() {
  const [range, setRange] = useState<Range>("day");
  const [chartMetric, setChartMetric] = useState<"bid" | "ask">("bid");
  const [history, setHistory] = useState<any[]>([]);

  const fetchHistory = async (r: Range) => {
    try {
      const res = await fetch(`/api/rate/history?range=${r}`);
      const data = await res.json();
      if (Array.isArray(data)) setHistory(data);
    } catch (error) {
      console.error("Error fetching history:", error);
    }
  };

  useEffect(() => {
    fetchHistory(range);
    const historyInterval = setInterval(() => fetchHistory(range), 30000);
    return () => clearInterval(historyInterval);
  }, [range]);

  const fmtTick = (value: any) => {
    if (!value) return "";
    const d = new Date(value as string);
    if (range === "day") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (range === "week" || range === "month")
      return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString([], { month: "short", year: "2-digit" });
  };

  return (
    <div className="rounded-3xl p-6 mb-8 border border-white/10 bg-slate-900/60 backdrop-blur-xl shadow-xl">
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-200">Price History</h3>
          <p className="text-xs text-indigo-300/80">
            {chartMetric === "ask" ? "Bank Sells (Ask)" : "Bank Buys (Bid)"} · Daily Snapshot
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Metric switcher: Buy (Bid) vs Sell (Ask) */}
          <div className="flex p-1 bg-black/30 rounded-xl ring-1 ring-white/10">
            <button
              onClick={() => setChartMetric("bid")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                chartMetric === "bid"
                  ? "bg-indigo-500 text-white shadow"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Buy (Bid)
            </button>
            <button
              onClick={() => setChartMetric("ask")}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                chartMetric === "ask"
                  ? "bg-indigo-500 text-white shadow"
                  : "text-slate-400 hover:text-slate-200"
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
                    ? "bg-indigo-500 text-white shadow"
                    : "text-slate-400 hover:text-slate-200"
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
                tick={{ fontSize: 11, fill: "#64748b" }}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                domain={["auto", "auto"]}
                orientation="right"
                tick={{ fontSize: 12, fill: "#64748b" }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgba(10,10,15,0.95)",
                  borderColor: "rgba(255,255,255,0.12)",
                  borderRadius: "12px",
                  color: "#f8fafc",
                  backdropFilter: "blur(8px)",
                }}
                itemStyle={{ color: "#a5b4fc" }}
                formatter={(val: any) => [
                  `${Number(val).toLocaleString()} KHR`,
                  chartMetric === "ask" ? "Bank Sells (Ask)" : "Bank Buys (Bid)",
                ]}
                labelFormatter={(value) => {
                  if (!value) return "";
                  const d = new Date(value as string);
                  return range === "day"
                    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : d.toLocaleDateString([], {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
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
  );
}
