"use client";

import React, { memo, useEffect, useId, useMemo, useRef, useState } from 'react';

export type ChartPoint = { bid: number; ask: number; t: number };

interface PriceChartProps {
  points: ChartPoint[];
  metric: 'bid' | 'ask';
  /** Step line = price holds until it changes (best for intraday change-based data) */
  step?: boolean;
  height?: number;
  seriesLabel: string;
  formatTick: (t: number) => string;
  formatLabel: (t: number) => string;
}

const PAD = { top: 14, right: 58, bottom: 28, left: 6 };

function niceScale(min: number, max: number, target = 4) {
  if (min === max) {
    min -= 5;
    max += 5;
  }
  const raw = (max - min) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return { lo, hi, ticks };
}

function PriceChart({
  points,
  metric,
  step = false,
  height = 288,
  seriesLabel,
  formatTick,
  formatLabel,
}: PriceChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const gradId = useId().replace(/:/g, '');

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (!width || points.length === 0) return null;

    // A single point is drawn as a flat line across the chart
    const pts =
      points.length === 1
        ? [points[0], { ...points[0], t: points[0].t + 1 }]
        : points;

    const values = pts.map((p) => p[metric]);
    const { lo, hi, ticks } = niceScale(Math.min(...values), Math.max(...values));
    const t0 = pts[0].t;
    const t1 = pts[pts.length - 1].t;
    const innerW = Math.max(1, width - PAD.left - PAD.right);
    const innerH = Math.max(1, height - PAD.top - PAD.bottom);

    const x = (t: number) => PAD.left + (t1 === t0 ? innerW / 2 : ((t - t0) / (t1 - t0)) * innerW);
    const y = (v: number) => PAD.top + ((hi - v) / (hi - lo || 1)) * innerH;

    const xy = pts.map((p) => [x(p.t), y(p[metric])] as const);
    let line = `M${xy[0][0].toFixed(1)},${xy[0][1].toFixed(1)}`;
    for (let i = 1; i < xy.length; i++) {
      const [px, py] = xy[i];
      line += step
        ? `H${px.toFixed(1)}V${py.toFixed(1)}`
        : `L${px.toFixed(1)},${py.toFixed(1)}`;
    }
    const bottom = PAD.top + innerH;
    const area = `${line}V${bottom}H${xy[0][0].toFixed(1)}Z`;

    const xTicks = Array.from({ length: 5 }, (_, i) => t0 + ((t1 - t0) * i) / 4);

    return { pts, xy, line, area, ticks, y, x, xTicks, t0, t1, innerW, bottom };
  }, [points, metric, step, width, height]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = geo.t0 + ((px - PAD.left) / geo.innerW) * (geo.t1 - geo.t0);
    let idx = 0;
    if (step) {
      // price active at time t = last point at or before t
      for (let i = 0; i < geo.pts.length; i++) if (geo.pts[i].t <= t) idx = i;
    } else {
      let best = Infinity;
      geo.pts.forEach((p, i) => {
        const d = Math.abs(p.t - t);
        if (d < best) {
          best = d;
          idx = i;
        }
      });
    }
    setHover(idx);
  };

  const h = hover !== null && geo ? geo.pts[hover] : null;
  const hx = h && geo ? Math.min(Math.max(PAD.left, geo.x(h.t)), PAD.left + geo.innerW) : 0;
  const hy = h && geo ? geo.y(h[metric]) : 0;

  return (
    <div ref={wrapRef} className="relative w-full select-none" style={{ height }}>
      {geo && (
        <svg
          width={width}
          height={height}
          className="block"
          style={{ touchAction: 'pan-y' }}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity={0.45} />
              <stop offset="70%" stopColor="#6366f1" stopOpacity={0.12} />
              <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
            </linearGradient>
          </defs>

          {/* grid + y labels */}
          {geo.ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={PAD.left + geo.innerW}
                y1={geo.y(v)}
                y2={geo.y(v)}
                stroke="rgba(255,255,255,0.06)"
                strokeDasharray="3 3"
              />
              <text x={PAD.left + geo.innerW + 8} y={geo.y(v) + 4} fill="#64748b" fontSize={12}>
                {v.toLocaleString()}
              </text>
            </g>
          ))}

          {/* x labels */}
          {geo.xTicks.map((t, i) => (
            <text
              key={i}
              x={geo.x(t)}
              y={height - 8}
              fill="#64748b"
              fontSize={11}
              textAnchor={i === 0 ? 'start' : i === geo.xTicks.length - 1 ? 'end' : 'middle'}
            >
              {formatTick(t)}
            </text>
          ))}

          <path d={geo.area} fill={`url(#${gradId})`} />
          <path d={geo.line} fill="none" stroke="#818cf8" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />

          {h && (
            <g pointerEvents="none">
              <line x1={hx} x2={hx} y1={PAD.top} y2={geo.bottom} stroke="rgba(165,180,252,0.35)" />
              <circle cx={hx} cy={hy} r={5} fill="#818cf8" stroke="#0a0a0f" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}

      {h && geo && (
        <div
          className="pointer-events-none absolute z-10 rounded-xl border border-white/10 bg-[#0a0a0f]/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
          style={{
            left: Math.min(Math.max(hx, 80), width - 80),
            top: Math.max(hy - 64, 0),
            transform: 'translateX(-50%)',
          }}
        >
          <div className="text-slate-400">{formatLabel(h.t)}</div>
          <div className="mt-0.5 font-semibold text-indigo-300 tabular-nums">
            {seriesLabel}: {h[metric].toLocaleString()} KHR
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(PriceChart);
