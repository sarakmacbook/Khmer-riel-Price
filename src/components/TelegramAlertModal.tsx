"use client";

import React, { useState, useEffect } from 'react';
import { Send, X, Check, AlertCircle, RefreshCw, Bell, Radio, ExternalLink } from 'lucide-react';

interface TelegramAlertModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentBid: number | null;
  currentAsk: number | null;
}

export default function TelegramAlertModal({
  isOpen,
  onClose,
  currentBid,
  currentAsk,
}: TelegramAlertModalProps) {
  const [configMode, setConfigMode] = useState<'webhook' | 'bot'>('webhook');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [chatId, setChatId] = useState('');
  const [botToken, setBotToken] = useState('');
  const [condition, setCondition] = useState<'change' | 'above' | 'below'>('change');
  const [targetRate, setTargetRate] = useState('');
  const [active, setActive] = useState(true);

  const [loadingInitial, setLoadingInitial] = useState(true);
  const [testState, setTestState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Load existing settings
  useEffect(() => {
    if (!isOpen) return;
    setTestState('idle');
    setSaveState('idle');

    fetch('/api/telegram/settings')
      .then((res) => res.json())
      .then((data) => {
        if (data.configured) {
          setWebhookUrl(data.webhookUrl || '');
          setChatId(data.chatId || '');
          setBotToken(data.botToken || '');
          setCondition(data.condition || 'change');
          setTargetRate(data.targetRate || '');
          setActive(data.active ?? true);
          if (data.webhookUrl && !data.chatId) {
            setConfigMode('webhook');
          } else if (data.chatId) {
            setConfigMode('bot');
          }
        }
      })
      .catch((err) => console.error('Failed to load telegram settings', err))
      .finally(() => setLoadingInitial(false));
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSendTest = async () => {
    setTestState('loading');
    setTestMessage('');
    try {
      const res = await fetch('/api/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: configMode === 'webhook' ? webhookUrl : null,
          botToken: configMode === 'bot' ? botToken : null,
          chatId: chatId,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setTestState('error');
        setTestMessage(data.error || 'Failed to send alert');
      } else {
        setTestState('success');
        setTestMessage('Test alert successfully sent to Telegram!');
      }
    } catch (err: any) {
      setTestState('error');
      setTestMessage(err.message || 'Network error');
    }
  };

  const handleSave = async () => {
    setSaveState('saving');
    try {
      const res = await fetch('/api/telegram/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          webhookUrl: configMode === 'webhook' ? webhookUrl : null,
          chatId: chatId || null,
          botToken: configMode === 'bot' ? botToken : null,
          condition,
          targetRate: targetRate || null,
          active,
        }),
      });

      if (res.ok) {
        setSaveState('saved');
        setTimeout(() => {
          setSaveState('idle');
          onClose();
        }, 1200);
      } else {
        setSaveState('idle');
        alert('Failed to save settings');
      }
    } catch (err) {
      setSaveState('idle');
      console.error(err);
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
                  Telegram Bot & Chat ID
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
                    Start your bot on Telegram or send <code>/start</code> to discover your Chat ID.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">
                    Bot Token <span className="text-slate-500">(Optional if configured on VPS / .env)</span>
                  </label>
                  <input
                    type="password"
                    value={botToken}
                    onChange={(e) => setBotToken(e.target.value)}
                    placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white placeholder-slate-500 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
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
                  On Rate Change
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

            {/* Test Status feedback */}
            {testState === 'success' && (
              <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-xs text-indigo-300 flex items-center gap-2">
                <Check className="h-4 w-4 shrink-0 text-indigo-400" />
                <span>{testMessage}</span>
              </div>
            )}
            {testState === 'error' && (
              <div className="p-3 rounded-xl bg-slate-800 border border-white/10 text-xs text-rose-300 flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span className="truncate">{testMessage}</span>
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
                disabled={testState === 'loading' || (configMode === 'webhook' && !webhookUrl) || (configMode === 'bot' && !chatId)}
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
