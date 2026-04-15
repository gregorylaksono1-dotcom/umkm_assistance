import {
  FLOOD_REPLY_TEXT,
  INCOMING_GUARDS,
  RATE_LIMIT_REPLY_TEXT,
} from "./incomingGuardsConfig.js";

const { time, rate, flood } = INCOMING_GUARDS;

export { FLOOD_REPLY_TEXT, RATE_LIMIT_REPLY_TEXT };

/**
 * @param {Record<string, unknown> | undefined} metaItem baris sender_meta
 * @param {number} now
 * @returns {{ allowed: boolean, rlMinuteSlot: number, rlMinuteCount: number, rlHourSlot: number, rlHourCount: number } | { allowed: false }}
 */
export function evaluateIncomingMessageRate(metaItem, now = Date.now()) {
  const minuteSlot = Math.floor(now / time.minuteMs);
  const hourSlot = Math.floor(now / time.hourMs);

  const prev = metaItem ?? {};
  let mCount =
    prev.rlMinuteSlot === minuteSlot ? Number(prev.rlMinuteCount ?? 0) : 0;
  let hCount = prev.rlHourSlot === hourSlot ? Number(prev.rlHourCount ?? 0) : 0;

  const wouldMinute = mCount + 1;
  const wouldHour = hCount + 1;

  if (wouldMinute > rate.maxPerMinute || wouldHour > rate.maxPerHour) {
    return { allowed: false };
  }

  return {
    allowed: true,
    rlMinuteSlot: minuteSlot,
    rlMinuteCount: wouldMinute,
    rlHourSlot: hourSlot,
    rlHourCount: wouldHour,
  };
}

/**
 * Guard flood: burst di atas ambang → blok + reply sekali; lalu abaikan sampai floodUntil.
 * @param {Record<string, unknown> | undefined} metaItem sender_meta
 * @param {number} [now]
 * @returns
 * | { outcome: 'cooldown' }
 * | { outcome: 'triggered'; floodUntil: number; floodWindowStart: number; floodWindowCount: number }
 * | { outcome: 'ok'; floodWindowStart: number; floodWindowCount: number; clearExpiredFloodUntil: boolean }
 */
export function evaluateFloodGuard(metaItem, now = Date.now()) {
  const prev = metaItem ?? {};
  const floodUntilRaw = prev.floodUntil != null ? Number(prev.floodUntil) : 0;

  if (floodUntilRaw > now) {
    return { outcome: "cooldown" };
  }

  let windowStart = Number(prev.floodWindowStart ?? 0);
  let windowCount = Number(prev.floodWindowCount ?? 0);
  if (!windowStart || now - windowStart > flood.windowMs) {
    windowStart = now;
    windowCount = 0;
  }

  const wouldCount = windowCount + 1;
  if (wouldCount > flood.messageThreshold) {
    return {
      outcome: "triggered",
      floodUntil: now + flood.cooldownMs,
      floodWindowStart: now,
      floodWindowCount: 0,
    };
  }

  return {
    outcome: "ok",
    floodWindowStart: windowStart,
    floodWindowCount: wouldCount,
    clearExpiredFloodUntil: floodUntilRaw > 0 && floodUntilRaw <= now,
  };
}
