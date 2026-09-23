"use client";

import { useEffect, useState } from "react";
import { Share, PlusSquare, X, Download } from "lucide-react";
import BrandMark from "@/components/BrandMark";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "wingrate-install-dismissed";

export default function InstallToHomescreen() {
  const [isIOS, setIsIOS] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    const ua = window.navigator.userAgent;
    // iPhone/iPod/iPad, plus iPadOS 13+ which reports as Mac with touch.
    const ios =
      /iphone|ipad|ipod/i.test(ua) ||
      (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
    setIsIOS(ios);

    const standalone =
      (window.navigator as any).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    setInstalled(standalone);

    setDismissed(localStorage.getItem(DISMISS_KEY) === "1");

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setDismissed(false);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  // Android/Chrome/desktop: show only when the browser offers an install prompt
  if (!isIOS && !deferred) return null;
  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  const installAndroid = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setDeferred(null);
  };

  return (
    <div className="rounded-2xl p-5 mb-8 border border-indigo-500/30 bg-indigo-500/10 relative">
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute top-3 right-3 text-slate-400 hover:text-white p-1"
      >
        <X className="h-4 w-4" />
      </button>

      <div className="flex items-center gap-2 mb-3">
        <BrandMark title="WingRate" className="h-9 w-9 shrink-0 rounded-xl" />
        <div>
          <p className="text-sm font-bold text-white leading-tight">
            Add WingRate to Home Screen
          </p>
          <p className="text-[11px] text-indigo-200/80">
            {isIOS ? "Works on iPhone & iPad with iOS / iPadOS 26" : "Install as an app"}
          </p>
        </div>
      </div>

      {isIOS ? (
        <ol className="space-y-2 text-xs text-indigo-100/90">
          <li className="flex items-start gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-[10px] font-bold text-white">1</span>
            <span className="flex items-center gap-1.5">
              Tap the <strong>Share</strong> button in Safari
              <Share className="h-4 w-4 text-indigo-300" />
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-[10px] font-bold text-white">2</span>
            <span className="flex items-center gap-1.5">
              Choose <strong>Add to Home Screen</strong>
              <PlusSquare className="h-4 w-4 text-indigo-300" />
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-[10px] font-bold text-white">3</span>
            <span>Tap <strong>Add</strong> — WingRate opens full-screen like a native app, with a live icon and notifications.</span>
          </li>
        </ol>
      ) : (
        <button
          onClick={installAndroid}
          className="mt-1 inline-flex items-center gap-2 rounded-xl bg-indigo-500 hover:bg-indigo-400 transition-colors px-4 py-2.5 text-xs font-bold text-white"
        >
          <Download className="h-4 w-4" />
          Install WingRate
        </button>
      )}
    </div>
  );
}
