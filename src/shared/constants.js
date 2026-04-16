/** Harga per credit (IDR), selaras dengan Snap Midtrans / notifikasi. */
export const CREDIT_UNIT_PRICE_IDR = 600;

/** Minimum credit per transaksi pembelian (validasi aplikasi Anda). */
export const MIN_CREDIT_PURCHASE = 10;

/**
 * Slot gratis awal pada profil baru (billing_usage_credit PROFILE).
 * Bisa 0 jika produk hanya berbayar.
 */
export const FREE_CREDIT_INITIAL = 3;

/** URL info produk (perintah `info`). */
export const INFO_PRODUCT_URL = "https://dapurartisan.arbcelebes.com";

/** Bucket S3 untuk unggahan dari Telegram (override env UPLOAD_S3_BUCKET). */
export const UPLOAD_S3_BUCKET_DEFAULT = "dapurartisan";
