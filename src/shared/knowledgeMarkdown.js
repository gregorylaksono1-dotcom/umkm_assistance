/**
 * Isi sinkron dengan src/processIntent/knowledge/*.md (untuk bundle Lambda).
 * Setelah edit file .md, salin ke sini.
 */

const PRICING = `DapurArtisan adalah layanan AI untuk membuat konten makanan siap posting.

Harga:
- Rp600 per gambar (1 credit = 1 edit)

Sudah termasuk:
- edit theme / style gambar
- banner teks promosi
- caption
- hashtag

Minimum pembelian:
- 10 credit

Penjelasan tambahan:
- semakin banyak gambar yang dibuat, semakin hemat dibanding jasa desain manual
- cocok untuk UMKM yang ingin konten cepat dan murah

Cara menjawab:
- jawab singkat dan jelas
- highlight bahwa sudah all-in (tidak ada biaya tambahan)`;

const FITUR = `DapurArtisan memiliki fitur utama:

1. AI Image Styling
Mengubah foto makanan menjadi berbagai tema:
- Hangat & Menggugah
- Segar & Cerah
- Elegan Premium
- Tradisional Nusantara
- Minimalis Clean
- Instagramable

2. Auto Banner Text
Menambahkan teks promosi otomatis seperti:
- Promo Hari Ini
- Best Seller
- Diskon

3. Caption Generator
Membuat caption marketing otomatis yang menarik

4. Hashtag Generator
Memberikan hashtag relevan untuk meningkatkan jangkauan

Cara menjawab:
- fokus pada kemudahan (tinggal upload → jadi)
- jangan terlalu teknis`;

const VALUE = `DapurArtisan membantu pelaku usaha makanan untuk:

- membuat konten marketing dalam hitungan detik
- menghemat biaya fotografer dan desainer
- meningkatkan daya tarik visual produk
- menjaga konsistensi branding

Keunggulan utama:
- cepat
- murah
- siap posting

Target pengguna:
- UMKM makanan & minuman
- penjual kue / bakery
- cafe dan catering

Cara menjawab:
- gunakan bahasa santai
- relate ke jualan (biar lebih laku)`;

const CARA_PAKAI = `Cara menggunakan DapurArtisan:
Bisa lewat web atau aplikasi whatsapp / Telegram. Kalau lewat whatsapp, bisa langsung upload gambar saja.
1. Upload foto makanan
2. Pilih tema / style
3. AI akan memproses gambar
4. Hasil langsung siap posting (sudah ada banner, caption, hashtag)

Tidak perlu:
- skill desain
- edit manual

Estimasi waktu:
- sangat cepat (hitungan detik)

Cara menjawab:
- buat simple
- step-by-step`;

const PURCHASE = `DapurArtisan menggunakan sistem credit untuk melakukan edit gambar.

Cara pembelian credit:

1. User menentukan jumlah credit yang ingin dibeli (minimal 10 credit)
2. System akan membuat dan mengirimkan payment link
3. User melakukan pembayaran melalui link tersebut
4. Setelah pembayaran berhasil, system akan otomatis mendeteksi pembayaran
5. User akan mendapatkan notifikasi bahwa pembayaran berhasil
6. Credit akan langsung masuk ke akun user
7. User bisa langsung mulai request edit gambar

Informasi penting:
- minimal pembelian: 10 credit
- 1 credit = 1 edit gambar
- harga per edit: Rp600

Setelah pembayaran berhasil:
- user bisa langsung upload gambar
- tidak perlu aktivasi tambahan

Cara AI menjawab:
- jelaskan flow dengan sederhana
- arahkan user ke langkah berikutnya (beli → bayar → pakai)
- gunakan bahasa santai dan meyakinkan`;

const FAQ = `Q: Bisa untuk semua jenis makanan?
A: Bisa, mulai dari kue, minuman, makanan berat, sampai snack.

Q: Apakah harus foto profesional?
A: Tidak, foto biasa juga bisa ditingkatkan oleh AI.

Q: Bisa untuk jualan online?
A: Sangat cocok, terutama untuk Instagram, WhatsApp, dan marketplace.

Q: Apakah hasilnya langsung bisa dipakai?
A: Ya, hasil sudah lengkap dengan teks, caption, dan hashtag.

Cara menjawab:
- singkat
- langsung ke point`;

/** Sinkron dengan src/processIntent/knowledge/fallback.md */
const FALLBACK = `Jika jawaban tidak ditemukan dalam konteks yang diberikan:
- jangan mengarang jawaban
- gunakan fallback response
- tetap arahkan ke layanan DapurArtisan`;

export const KNOWLEDGE_FALLBACK_GUIDE = FALLBACK;

export const KNOWLEDGE_BY_INTENT = {
  tanya_harga: PRICING,
  tanya_fitur: FITUR,
  tanya_keuntungan: VALUE,
  tanya_cara_pakai: CARA_PAKAI,
  beli_credit: PURCHASE,
  faq: FAQ,
};

/** Intent classifier → konten referensi (default FAQ). */
export function knowledgeMarkdownForIntent(intent) {
  switch (intent) {
    case "tanya_harga":
      return KNOWLEDGE_BY_INTENT.tanya_harga;
    case "tanya_fitur":
      return KNOWLEDGE_BY_INTENT.tanya_fitur;
    case "tanya_keuntungan":
      return KNOWLEDGE_BY_INTENT.tanya_keuntungan;
    case "tanya_cara_pakai":
      return KNOWLEDGE_BY_INTENT.tanya_cara_pakai;
    case "beli_credit":
      return KNOWLEDGE_BY_INTENT.beli_credit;
    default:
      return KNOWLEDGE_BY_INTENT.faq;
  }
}
