import { after } from 'next/server';
import { errMsg } from '@/lib/store/types';

/**
 * Run a task once the HTTP response has been sent.
 *
 * On Vercel this is `after()`: the platform keeps the invocation alive for the
 * work, so a slow Telegram delivery (timeouts + retries) no longer delays the
 * response the browser is waiting for. Outside a request scope — tests, CLI
 * scripts, the Docker poller — `after()` throws, so the task simply runs inline.
 */
export function runAfterResponse(task: () => Promise<unknown>, label = 'after-response'): void {
  const safe = () => task().catch((e) => console.error(`[${label}]`, errMsg(e)));
  try {
    after(safe);
  } catch {
    void safe();
  }
}
