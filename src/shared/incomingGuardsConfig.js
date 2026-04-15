/**
 * Konfigurasi flood guard & rate limit pesan masuk (webhook).
 * Ubah nilai di sini saja; logika ada di rateLimit.js.
 */
export const INCOMING_GUARDS = {
  time: {
    minuteMs: 60_000,
    hourMs: 3_600_000,
  },
  /** Batas per menit / per jam (anti spam berkelanjutan). */
  rate: {
    maxPerMinute: 10,
    maxPerHour: 50,
  },
  /**
   * Burst: lebih dari messageThreshold pesan dalam windowMs → cooldown cooldownMs.
   */
  flood: {
    windowMs: 20_000,
    messageThreshold: 18,
    cooldownMs: 10 * 60_000,
  },
};

const floodCooldownMinutes = Math.round(
  INCOMING_GUARDS.flood.cooldownMs / INCOMING_GUARDS.time.minuteMs,
);

export const RATE_LIMIT_REPLY_TEXT = "Mohon tunggu sebentar ya \u{1F64F}";

export const FLOOD_REPLY_TEXT =
  `Kak, maaf sepertinya terditeksi flood pesan. Pesan baru akan di proses di ${floodCooldownMinutes} menit berikutnya`;
