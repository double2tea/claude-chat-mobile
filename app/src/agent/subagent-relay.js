import { DEDUP_CAP } from './message-dedup.js';
import { setCapped } from '../shared/bounded-map.js';

export function createSubagentRelayReceipts(cap = DEDUP_CAP) {
  const active = new Map();
  const receipts = new Map();

  return function relay(id, text, { start, confirm }) {
    const previous = active.get(id) || receipts.get(id);
    if (previous && previous.text !== text) {
      return Promise.resolve({ ok: false, error: '续聊请求与原消息不一致' });
    }
    if (previous?.running) return previous.running;
    if (previous?.result) return Promise.resolve(previous.result);
    if (active.size >= cap) {
      return Promise.resolve({ ok: false, error: '续聊请求过多，请稍后重试' });
    }

    const receipt = previous || { text };
    receipt.running = (async () => {
      if (!receipt.observe) {
        const started = await start();
        if (!started.observe) return started.result;
        receipt.observe = started.observe;
        setCapped(receipts, id, receipt, cap);
      }
      const { result, pending } = await confirm(receipt.observe);
      if (!pending) {
        receipt.result = result;
        receipt.observe = null;
      }
      return result;
    })().finally(() => {
      receipt.running = null;
      active.delete(id);
    });
    active.set(id, receipt);
    return receipt.running;
  };
}
