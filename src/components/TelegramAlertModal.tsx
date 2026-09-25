"use client";

import React, { useState, useEffect } from 'react';
import { Send, X, Check, AlertCircle, RefreshCw, Bell, KeyRound, Info } from 'lucide-react';

interface TelegramAlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentBid: number | null;
  currentAsk: number | null;
}

interface Settings {
  configured?: boolean;
  active?: boolean;
  webhookUrl?: string;
  chatId?: string;
  /** Never sent by the API — only `hasToken` tells us a token exists. */
  botToken?: string;
  hasToken?: boolean;
  condition?: 'change' | 'above' | 'below';
  targetRate?: string;
  customMessage?: string;
  storage?: string;
  persistent?: boolean;
  error?: string;
}

export default function TelegramAlertModal({
  isOpen,
  onClose,
  currentBid,
}: TelegramAlertModalProps) {
  const [configMode, setConfigMode] = useState<'webhook' | 'bot'>('webhook');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [chatId, setChatId] = useState('');
  const [botToken, setBotToken] = useState('');
  const [condition, setCondition] = useState<'change' | 'above' | 'below'>('change');
  const [targetRate, setTargetRate] = useState('');
  const [customMessage, setCustomMessage] = useState('');
  const [active, setActive] = useState(true);

  const [hasToken, setHasToken] = useState(false);
  const [storage, setStorage] = useState('');
  const [persistent, setPersistent] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [loadingInitial, setLoadingInitial] = useState(true);
  const [testState, setTestState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [saveError, setSaveError] = useState('');

  // Load existing settings
  useEffect(() => {
    if (!isOpen) return;
    setTestState('idle');
    setSaveState('idle');
    setSaveError('');
    setLoadError('');
    setLoadingInitial(true);

    let cancelled = false;
    fetch('/api/telegram/settings')
      .then((res) => res.json())
      .then((data: Settings) => {
        if (cancelled) return;
        setHasToken(Boolean(data.hasToken));
        setStorage(data.storage || '');
        setPersistent(data.persistent !== false);
        setLoadError(data.error || '');
        if (data.configured) {
          setWebhookUrl(data.webhookUrl || '');
          setChatId(data.chatId || '');
          // A saved token is never returned; leaving this blank keeps it.
          setBotToken('');
          setCondition(data.condition || 'change');
          setTargetRate(data.targetRate || '');
          setCustomMessage(data.customMessage || '');
          setActive(data.active ?? true);
          setConfigMode(data.chatId ? 'bot' : 'webhook');
        }
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err?.message || 'Could not load alert settings');
      })
      .finally(() => {
        if (!cancelled) setLoadingInitial(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const trimmedChat = chatId.trim();
  const trimmedUrl = webhookUrl.trim();
  const targetMissing = condition !== 'change' && !targetRate.trim();
  const canSendTest = !targetMissing && (configMode === 'webhook' ? Boolean(trimmedUrl) : Boolean(trimmedChat));

  const handleSendTest = async () => {
    setTestState('loading');
    setTestMessage('');
    try {
      const res = await fetch('/api/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // An empty token means "use the saved one / TELEGRAM_BOT_TOKEN".
        // In webhook mode the Chat ID is deliberately omitted so the test goes
        // through the webhook instead of the saved bot.
        body: JSON.stringify({
          mode: configMode,
          webhookUrl: configMode === 'webhook' ? trimmedUrl : null,
          botToken: configMode === 'bot' ? botToken.trim() || null : null,
          chatId: configMode === 'bot' ? trimmedChat || null : null,
          // The test previews this exact template, so the form value wins.
          customMessage: customMessage.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setTestState('error');
        setTestMessage(data.error || `Failed to send alert (HTTP ${res.status})`);
      } else {
        setTestState('success');
        setTestMessage(
          data.used?.tokenSource
            ? `Test alert sent — used ${data.used.tokenSource}.`
            : 'Test alert successfully sent to Telegram!',
        );
      }
    } catch (err) {
      setTestState('error');
      setTestMessage(err instanceof Error ? err.message : 'Network error');
    }
  };

  const handleSave = async () => {
    setSaveState('saving');
    setSaveError('');
    try {
      // Exactly one delivery channel is stored: in webhook mode the Chat ID is
      // cleared (otherwise the saved bot token would win over the webhook), and
      // in bot mode the webhook URL is cleared.
      const payload: Record<string, unknown> = {
        webhookUrl: configMode === 'webhook' ? trimmedUrl : null,
        chatId: configMode === 'bot' ? trimmedChat || null : null,
        condition,
        targetRate: targetRate.trim() || null,
        customMessage: customMessage.trim() || null,
        active,
      };
      // Omitted entirely when blank → the server keeps the token already stored.
      if (botToken.trim()) payload.botToken = botToken.trim();

      const res = await fetch('/api/telegram/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        if (botToken.trim()) setHasToken(true);
        setStorage(data.storage || storage);
        setPersistent(data.persistent !== false);
        setSaveState('saved');
        setTimeout(() => {
          setSaveState('idle');
          onClose();
        }, 1200);
      } else {
        setSaveState('idle');
        setSaveError(data.error || `Failed to save settings (HTTP ${res.status})`);
      }
    } catch (err) {
      setSaveState('idle');
      setSaveError(err instanceof Error ? err.message : 'Network error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-lg rounded-3xl p-6 bg-slate-900 border border-white/10 shadow-2xl text-slate-100 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-2xl bg-indigo-500/20 text-indigo-400 ring-1 ring-indigo-500/30">
              <Send className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                Telegram Webhook Alerts
              </h3>
              <p className="text-xs text-slate-400">Receive live exchange rate alerts on Telegram</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-white/10 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {loadingInitial ? (
          <div className="py-12 flex flex-col items-center justify-center text-slate-400 gap-3">
            <RefreshCw className="h-6 w-6 animate-spin text-indigo-400" />
            <span className="text-sm">Loading alert settings...</span>
          </div>
        ) : (
          <div className="py-5 space-y-5">
            {loadError && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
                <span>Could not read saved settings: {loadError}</span>
              </div>
            )}

            {/* Active Toggle */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-black/30 border border-white/10">
              <div className="flex items-center gap-2.5">
                <Bell className={`h-4 w-4 ${active ? 'text-indigo-400' : 'text-slate-500'}`} />
                <span className="text-sm font-semibold text-slate-200">Enable Automated Alerts</span>
              </div>
              <button
                type="button"
                onClick={() => setActive(!active)}
                className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors ${
                  active ? 'bg-indigo-500' : 'bg-slate-700'
                }`}
              >
                <div
                  className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform ${
                    active ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Mode Selector */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Connection Type
              </label>
              <div className="flex p-1 bg-black/30 rounded-xl ring-1 ring-white/10 text-xs font-bold">
                <button
                  type="button"
                  onClick={() => setConfigMode('webhook')}
                  className={`flex-1 py-2 rounded-lg transition-all ${
                    configMode === 'webhook'
                      ? 'bg-indigo-500 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Webhook URL
                </button>
                <button
                  type="button"
                  onClick={() => setConfigMode('bot')}
                  className={`flex-1 py-2 rounded-lg transition-all ${
                    configMode === 'bot'
                      ? 'bg-indigo-500 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Telegram Bot &amp; Chat ID
                </button>
              </div>
            </div>

            {/* Input fields based on mode */}
            {configMode === 'webhook' ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Telegram / Custom Webhook URL
                  </label>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(e) => setWebhookUrl(e.target.value)}
                    placeholder="https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat_id>"
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <p className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                    Tip: Direct Telegram Bot API URL or any webhook service (Make, Zapier, custom forwarder).
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Telegram Chat ID
                  </label>
                  <input
                    type="text"
                    value={chatId}
                    onChange={(e) => setChatId(e.target.value)}
                    placeholder="e.g. 123456789 or @channelusername"
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                  <p className="text-[11px] text-slate-500 mt-1">
                    Send <code>/start</code> to your bot — it replies with your Chat ID.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Bot Token <span className="text-slate-500">(Optional if configured on VPS / .env)</span>
                  </label>
                  <div className="relative">
                    <KeyRound className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input
                      type="password"
                      value={botToken}
                      onChange={(e) => setBotToken(e.target.value)}
                      placeholder={hasToken ? 'Saved — leave blank to keep it' : '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ'}
                      className="w-full bg-black/40 border border-white/10 rounded-xl pl-9 pr-4 py-2.5 text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    />
                  </div>
                  {hasToken && !botToken.trim() && (
                    <p className="text-[11px] text-indigo-300/80 mt-1">
                      A bot token is already saved for this deployment — it will be used.
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Condition selector */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Alert Trigger
              </label>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setCondition('change')}
                  className={`p-2.5 rounded-xl border text-center transition-all ${
                    condition === 'change'
                      ? 'border-indigo-500/50 bg-indigo-500/20 text-white font-bold'
                      : 'border-white/10 bg-black/30 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Only on Price Move
                </button>
                <button
                  type="button"
                  onClick={() => setCondition('above')}
                  className={`p-2.5 rounded-xl border text-center transition-all ${
                    condition === 'above'
                      ? 'border-indigo-500/50 bg-indigo-500/20 text-white font-bold'
                      : 'border-white/10 bg-black/30 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Rate Above
                </button>
                <button
                  type="button"
                  onClick={() => setCondition('below')}
                  className={`p-2.5 rounded-xl border text-center transition-all ${
                    condition === 'below'
                      ? 'border-indigo-500/50 bg-indigo-500/20 text-white font-bold'
                      : 'border-white/10 bg-black/30 text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Rate Below
                </button>
              </div>

              {condition === 'change' && (
                <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                  Sends an alert <b className="text-slate-400">only when the Wing Bank rate actually moves</b> (buy
                  or sell price changes, up or down) — never on the same price twice.
                </p>
              )}

              {condition !== 'change' && (
                <div className="mt-3">
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Target Rate (KHR)
                  </label>
                  <input
                    type="number"
                    value={targetRate}
                    onChange={(e) => setTargetRate(e.target.value)}
                    placeholder={currentBid ? currentBid.toString() : '4060'}
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              )}
            </div>

            {/* Custom alert message */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Custom Alert Message <span className="text-slate-500 normal-case font-medium">(Optional)</span>
              </label>
              <textarea
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value.slice(0, 1200))}
                rows={3}
                placeholder="e.g. 🇰🇭 Riel moved! Bid {bid} / Ask {ask} KHR ({arrow} {diff}) — {time}"
                className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-y leading-relaxed"
              />
              <p className="text-[11px] text-slate-500 mt-1.5 leading-relaxed">
                Leave blank for the default message. Codes you can use:{' '}
                <code className="text-slate-400">{'{bid}'}</code> <code className="text-slate-400">{'{ask}'}</code>{' '}
                <code className="text-slate-400">{'{diff}'}</code> <code className="text-slate-400">{'{arrow}'}</code>{' '}
                <code className="text-slate-400">{'{time}'}</code> <code className="text-slate-400">{'{link}'}</code>{' '}
                <span className="text-slate-600">(max 1200 characters)</span>
              </p>
            </div>

            {/* Test Status feedback */}
            {testState === 'success' && (
              <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-300 flex items-start gap-2">
                <Check className="h-4 w-4 shrink-0 mt-0.5 text-indigo-400" />
                <span>{testMessage}</span>
              </div>
            )}
            {testState === 'error' && (
              <div className="p-3 rounded-xl bg-slate-800 border border-white/10 text-xs text-rose-300 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
                <span className="break-words">{testMessage}</span>
              </div>
            )}
            {saveError && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-rose-400" />
                <span className="break-words">{saveError}</span>
              </div>
            )}

            {!persistent && storage && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-300 flex items-start gap-2">
                <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
                <span>
                  Storage is <b>{storage}</b>: alerts work now but are not saved across restarts. Connect a database
                  (Postgres, Turso, MongoDB, Upstash Redis or Vercel Blob) to make them permanent.
                </span>
              </div>
            )}

            {/* Quick Telegram Bot Info */}
            <div className="p-3.5 rounded-2xl bg-white/5 border border-white/10 text-[11px] text-slate-400 space-y-1">
              <p className="font-semibold text-slate-300">💡 Telegram Bot Commands:</p>
              <p>• <code>/start</code> — Get your chat ID and bot greeting</p>
              <p>• <code>/rate</code> — Fetch live USD/KHR Wing Bank rates instantly</p>
              <p>• <code>/alert</code> — Subscribe your chat ID directly to rate updates</p>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleSendTest}
                disabled={testState === 'loading' || !canSendTest}
                className="flex-1 py-3 px-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold text-slate-200 transition-all flex items-center justify-center gap-2"
              >
                {testState === 'loading' ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Testing...
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5 text-indigo-400" />
                    Send Test Alert
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleSave}
                disabled={saveState === 'saving'}
                className="flex-1 py-3 px-4 rounded-xl bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 text-xs font-bold text-white transition-all shadow-lg shadow-indigo-500/25 flex items-center justify-center gap-2"
              >
                {saveState === 'saving' ? (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    Saving...
                  </>
                ) : saveState === 'saved' ? (
                  <>
                    <Check className="h-3.5 w-3.5" />
                    Saved!
                  </>
                ) : (
                  'Save Settings'
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
