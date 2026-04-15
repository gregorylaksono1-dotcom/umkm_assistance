import {
  INTENT_BELI_CREDIT,
  INTENT_BUATKAN_BANNER,
  INTENT_SALAM,
  INTENT_TANYA_INFO,
  INTENT_UNKNOWN,
  INTENT_UPLOAD_GAMBAR,
  normalizeIntentForRouting,
} from "./constants.js";
import {
  CONV_STATE_WAITING_TOPUP_AMOUNT,
  CONV_STATE_WAITING_TOPUP_CONFIRMATION,
} from "./senderConversationMeta.js";
import { SPEC_INTENT } from "./statefulIntentClassifier.js";

/**
 * @param {string} specIntent
 * @param {string|null} effectiveState
 * @param {{ hasImageAttachment?: boolean }} [opts]
 * @returns {string} intent router (snake / spasi) untuk dispatchByIntent
 */
export function mapSpecToRouterIntent(specIntent, effectiveState, opts = {}) {
  const { hasImageAttachment = false } = opts;
  const si = String(specIntent ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");

  if (!si || si === SPEC_INTENT.UNKNOWN) {
    if (
      effectiveState === CONV_STATE_WAITING_TOPUP_AMOUNT ||
      effectiveState === CONV_STATE_WAITING_TOPUP_CONFIRMATION
    ) {
      return normalizeIntentForRouting(INTENT_BELI_CREDIT);
    }
    return normalizeIntentForRouting(INTENT_UNKNOWN);
  }

  switch (si) {
    case SPEC_INTENT.CONFIRM_TOPUP:
    case SPEC_INTENT.CANCEL_TOPUP:
    case SPEC_INTENT.PROVIDE_TOPUP_AMOUNT:
    case SPEC_INTENT.TOPUP:
      return normalizeIntentForRouting(INTENT_BELI_CREDIT);
    case SPEC_INTENT.EDIT_IMAGE:
      return normalizeIntentForRouting(INTENT_UPLOAD_GAMBAR);
    case SPEC_INTENT.GENERATE_IMAGE:
      return normalizeIntentForRouting(
        hasImageAttachment ? INTENT_UPLOAD_GAMBAR : INTENT_BUATKAN_BANNER,
      );
    case SPEC_INTENT.FAQ:
      return normalizeIntentForRouting(INTENT_TANYA_INFO);
    case SPEC_INTENT.SMALL_TALK:
      return normalizeIntentForRouting(INTENT_SALAM);
    default:
      return normalizeIntentForRouting(INTENT_UNKNOWN);
  }
}
