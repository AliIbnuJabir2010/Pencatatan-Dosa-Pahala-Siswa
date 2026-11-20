// Server Dosa & Pahala Siswa (Node.js murni, tanpa framework).
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { jalankanPython, bacaLewatLayanan } = require('./python');
const { db, hash, buatPassword } = require('./db');

// Paket QR (dipasang lewat `npm install`)
let QRCode = null;
try { QRCode = require('qrcode'); } catch { console.log('! Paket QR belum terpasang. Jalankan: npm install'); }
const lokasiModul = nama => { try { return require.resolve(nama); } catch { return null; } };

// ---------- Pengaturan ----------
const PORT = process.env.PORT || 3000;
const FOLDER_PUBLIK = path.join(__dirname, 'public');
// Rute halaman. peran: 'guru' | 'murid' | 'semua' (harus login) | null (terbuka)
const HALAMAN = {
  '/':               { file: 'portal.html',   peran: null,    portal: true },  // pilih Murid / Guru / Admin
  '/admin':          { file: 'admin.html',    peran: 'admin', masuk: 'admin-masuk.html' },  // dashboard pusat
  '/guru':           { file: 'index.html',    peran: 'guru',  masuk: 'masuk.html' },        // daftar siswa + cek NISN / scan QR
  '/guru/aduan':     { file: 'aduan.html',    peran: 'guru' },                              // input aduan + poin
  '/guru/qr':        { file: 'qr.html',       peran: 'guru' },                              // cetak QR siswa
  '/guru/kategori':  { file: 'kategori.html', peran: 'guru' },                              // kelola kategori & poin
  '/guru/password':  { file: 'password.html', peran: 'guru' },                              // buat password murid
  '/murid':          { file: 'profil.html',   peran: 'murid', masuk: 'masuk.html' },        // profil murid sendiri
  '/akun':           { file: 'akun.html',     peran: 'semua' },                             // ganti password (semua peran)
};
const BERANDA = { guru: '/guru', murid: '/murid', admin: '/admin' };
const ALIAS_LAMA = {
  '/cari.html': '/guru', '/lapor.html': '/guru/aduan', '/login.html': '/', '/masuk': '/', '/admin/masuk': '/admin',
  '/aduan': '/guru/aduan', '/qr': '/guru/qr', '/kategori': '/guru/kategori', '/password': '/guru/password', '/profil': '/murid',
};
const FILE_STATIS = {
  '/style.css': { file: path.join(FOLDER_PUBLIK, 'style.css'), tipe: 'text/css; charset=utf-8' },
  '/ui.js':     { file: path.join(FOLDER_PUBLIK, 'ui.js'),     tipe: 'text/javascript; charset=utf-8' },
  '/scan.js':   { file: path.join(FOLDER_PUBLIK, 'scan.js'),   tipe: 'text/javascript; charset=utf-8' },
  '/jsqr.js':   { file: lokasiModul('jsqr'), tipe: 'text/javascript; charset=utf-8' }, // pembaca QR (cadangan)
};
const DURASI_SESI = 8 * 60 * 60 * 1000;
const MAKS_GAGAL_LOGIN = 5;
const DURASI_BLOKIR = 10 * 60 * 1000;

// ---------- Utilitas ----------
class HttpError extends Error {
  constructor(status, pesan) { super(pesan); this.status = status; }
}

const kirimJson = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

const hariIni = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD

function tanggalValid(t) {
  return /^\d{4}-\d{2}-\d{2}$/.test(t)
    && !isNaN(Date.parse(t))
    && new Date(t).toISOString().slice(0, 10) === t
    && t <= hariIni();
}

function bacaBody(req) {
  return new Promise((selesai, gagal) => {
    let data = '';
    req.on('data', potongan => {
      data += potongan;
      if (data.length > 100_000) { req.destroy(); gagal(new HttpError(413, 'Data terlalu besar.')); }
    });
    req.on('end', () => {
      try { selesai(JSON.parse(data || '{}')); }
      catch { gagal(new HttpError(400, 'Format data tidak valid.')); }
    });
  });
}

// ---------- Sesi & login ----------
// Sesi login (guru atau murid) disimpan di tabel `sesi`, jadi tetap berlaku walau server di-restart.
const percobaanGagal = new Map(); // "ip|username" -> { jumlah, sampai }

function ambilSesi(req) {
  const cocok = /(?:^|; )sid=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!cocok) return null;
  const s = db.prepare(`
    SELECT s.sid, s.peran, s.kadaluarsa, s.guru_id, s.admin_id, s.nisn, g.nama AS nama_guru, w.nama AS nama_siswa, a.nama AS nama_admin
    FROM sesi s
    LEFT JOIN admin a ON a.id = s.admin_id
    LEFT JOIN guru g  ON g.id = s.guru_id
    LEFT JOIN siswa w ON w.nisn = s.nisn
    WHERE s.sid = ?`).get(cocok[1]);
  if (!s) return null;
  if (s.kadaluarsa < Date.now()) {
    db.prepare('DELETE FROM sesi WHERE sid = ?').run(s.sid);
    return null;
  }
  if (s.peran === 'admin' && s.nama_admin) return { sid: s.sid, peran: 'admin', id: s.admin_id, nama: s.nama_admin };
  if (s.peran === 'guru' && s.nama_guru) return { sid: s.sid, peran: 'guru', id: s.guru_id, nama: s.nama_guru };
  if (s.peran === 'murid' && s.nama_siswa) return { sid: s.sid, peran: 'murid', nisn: s.nisn, nama: s.nama_siswa };
  return null;
}

// akun: baris guru atau siswa (atau undefined bila tidak ada). Akun tanpa password selalu ditolak.
function passwordBenar(akun, password) {
  // Tetap hitung hash walau akun tidak ada, supaya waktu respons sama.
  const hasil = hash(password, akun && akun.salt ? akun.salt : '0'.repeat(32));
  return Boolean(akun && akun.hash && akun.salt) &&
    crypto.timingSafeEqual(Buffer.from(hasil, 'hex'), Buffer.from(akun.hash, 'hex'));
}

// ---------- Handler API: akun ----------
async function login(req, res) {
  const { username = '', password = '', peran: diminta = '' } = await bacaBody(req);
  const u = String(username).trim();
  const kunci = `${req.socket.remoteAddress}|${u}`;
  const catatan = percobaanGagal.get(kunci);
  const diblokir = catatan && catatan.sampai > Date.now();

  if (diblokir && catatan.jumlah >= MAKS_GAGAL_LOGIN) {
    throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi 10 menit lagi.');
  }

  // 10 digit angka = NISN (murid); selain itu = username guru
  const murid = /^\d{10}$/.test(u);
  if (diminta && diminta !== (murid ? 'murid' : 'guru')) {
    throw new HttpError(401, diminta === 'murid' ? 'Masuk murid pakai NISN 10 digit.' : 'Murid masuk lewat halaman /murid.');
  }
  const akun = murid
    ? db.prepare('SELECT nisn, nama, hash, salt FROM siswa WHERE nisn = ?').get(u)
    : db.prepare('SELECT * FROM guru WHERE username = ?').get(u);

  if (murid && akun && !akun.hash) {
    throw new HttpError(403, 'Password murid ini belum dibuat. Minta guru membuatkannya.');
  }
  if (!passwordBenar(akun, String(password))) {
    percobaanGagal.set(kunci, {
      jumlah: (diblokir ? catatan.jumlah : 0) + 1,
      sampai: Date.now() + DURASI_BLOKIR,
    });
    throw new HttpError(401, murid ? 'NISN atau password salah.' : 'Username atau password salah.');
  }

  percobaanGagal.delete(kunci);
  if (murid) db.prepare("UPDATE siswa SET login_terakhir = datetime('now', 'localtime') WHERE nisn = ?").run(akun.nisn);
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesi (sid, peran, guru_id, nisn, kadaluarsa) VALUES (?, ?, ?, ?, ?)')
    .run(sid, murid ? 'murid' : 'guru', murid ? null : akun.id, murid ? akun.nisn : null, Date.now() + DURASI_SESI);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  kirimJson(res, 200, { peran: murid ? 'murid' : 'guru', nama: akun.nama });
}

// Login admin: endpoint dan halaman terpisah, tidak bisa dipakai guru/murid.
async function loginAdmin(req, res) {
  const { username = '', password = '' } = await bacaBody(req);
  const u = String(username).trim();
  const kunci = `admin|${req.socket.remoteAddress}|${u}`;
  const catatan = percobaanGagal.get(kunci);
  const diblokir = catatan && catatan.sampai > Date.now();
  if (diblokir && catatan.jumlah >= MAKS_GAGAL_LOGIN) throw new HttpError(429, 'Terlalu banyak percobaan. Coba lagi 10 menit lagi.');

  const akun = db.prepare('SELECT * FROM admin WHERE username = ?').get(u);
  if (!passwordBenar(akun, String(password))) {
    percobaanGagal.set(kunci, { jumlah: (diblokir ? catatan.jumlah : 0) + 1, sampai: Date.now() + DURASI_BLOKIR });
    throw new HttpError(401, 'Username atau password salah.');
  }
  percobaanGagal.delete(kunci);
  const sid = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sesi (sid, peran, admin_id, kadaluarsa) VALUES (?, ?, ?, ?)').run(sid, 'admin', akun.id, Date.now() + DURASI_SESI);
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
  kirimJson(res, 200, { peran: 'admin', nama: akun.nama });
}

function logout(req, res, { sesi }) {
  db.prepare('DELETE FROM sesi WHERE sid = ?').run(sesi.sid);
  res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
  kirimJson(res, 200, {});
}

const saya = (req, res, { sesi }) => kirimJson(res, 200, { peran: sesi.peran, nama: sesi.nama, nisn: sesi.nisn || null });

async function gantiPassword(req, res, { sesi }) {
  const b = await bacaBody(req);
  const lama = String(b.lama || ''), baru = String(b.baru || '');
  const minimal = sesi.peran === 'admin' ? 8 : 6;
  if (baru.length < minimal) throw new HttpError(400, `Password baru minimal ${minimal} karakter.`);
  if (baru.length > 100) throw new HttpError(400, 'Password terlalu panjang.');
  if (baru === lama) throw new HttpError(400, 'Password baru harus berbeda dari yang lama.');

  const [tabel, kolomId, idAkun, kolomSesi] = {
    guru:  ['guru',  'id',   sesi.id,   'guru_id'],
    admin: ['admin', 'id',   sesi.id,   'admin_id'],
    murid: ['siswa', 'nisn', sesi.nisn, 'nisn'],
  }[sesi.peran];
  const akun = db.prepare(`SELECT hash, salt FROM ${tabel} WHERE ${kolomId} = ?`).get(idAkun);
  if (!passwordBenar(akun, lama)) throw new HttpError(403, 'Password lama salah.');

  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(`UPDATE ${tabel} SET hash = ?, salt = ?${sesi.peran === 'murid' ? ', pw_diganti = 1' : ''} WHERE ${kolomId} = ?`)
    .run(hash(baru, salt), salt, idAkun);
  // Perangkat lain yang masih login dengan password lama dikeluarkan
  db.prepare(`DELETE FROM sesi WHERE sid != ? AND ${kolomSesi} = ?`).run(sesi.sid, idAkun);
  kirimJson(res, 200, { ok: true });
}

async function gantiNama(req, res, { sesi }) {
  const b = await bacaBody(req);
  const nama = bersihkan(b.nama, 60);
  if (nama.length < 3) throw new HttpError(400, 'Nama minimal 3 karakter.');
  const [tabel, kolomId, idAkun] = {
    guru:  ['guru',  'id',   sesi.id],
    admin: ['admin', 'id',   sesi.id],
    murid: ['siswa', 'nisn', sesi.nisn],
  }[sesi.peran];
  if (!db.prepare(`UPDATE ${tabel} SET nama = ? WHERE ${kolomId} = ?`).run(nama, idAkun).changes) {
    throw new HttpError(404, 'Akun tidak ditemukan.');
  }
  kirimJson(res, 200, { ok: true, nama });
}

// Guru membuat password acak untuk murid. Password hanya muncul SEKALI di jawaban ini
// (di database tersimpan dalam bentuk hash, jadi tidak bisa dilihat lagi, oleh siapa pun).
//   { nisn }        -> buat (atau buat ulang) untuk satu murid; sesi lamanya dikeluarkan
//   { semua: true } -> buat hanya untuk murid yang BELUM punya password
//   { kelas }       -> buat ulang untuk SEMUA murid di kelas itu
async function buatPasswordMurid(req, res) {
  const b = await bacaBody(req);
  let target;
  if (b.semua === true) {
    target = db.prepare('SELECT nisn, nama, kelas FROM siswa WHERE hash IS NULL ORDER BY kelas, nama').all();
  } else if (b.kelas) {
    target = db.prepare('SELECT nisn, nama, kelas FROM siswa WHERE kelas = ? ORDER BY nama').all(String(b.kelas));
  } else {
    target = [db.prepare('SELECT nisn, nama, kelas FROM siswa WHERE nisn = ?').get(String(b.nisn || ''))];
  }
  if (!target[0]) {
    if (b.semua === true || b.kelas) return kirimJson(res, 200, { hasil: [] });
    throw new HttpError(404, 'NISN tidak ditemukan.');
  }
  const ubah = db.prepare('UPDATE siswa SET hash = ?, salt = ?, pw_diganti = 0 WHERE nisn = ?');
  const keluarkan = db.prepare('DELETE FROM sesi WHERE nisn = ?');
  const hasil = target.map(s => {
    const password = buatPassword(), salt = crypto.randomBytes(16).toString('hex');
    ubah.run(hash(password, salt), salt, s.nisn);
    keluarkan.run(s.nisn);
    return { nisn: s.nisn, nama: s.nama, kelas: s.kelas, password };
  });
  kirimJson(res, 200, { hasil });
}

// ---------- Handler API: data siswa & poin ----------
const RINGKAS_SQL = `
  COUNT(l.id) AS total,
  COALESCE(SUM(l.jenis = 'dosa'), 0)   AS dosa,
  COALESCE(SUM(l.jenis = 'pahala'), 0) AS pahala,
  COALESCE(SUM(CASE WHEN l.jenis = 'dosa'   THEN l.poin END), 0) AS poin_dosa,
  COALESCE(SUM(CASE WHEN l.jenis = 'pahala' THEN l.poin END), 0) AS poin_pahala`;

const ringkasan = nisn => db.prepare(`SELECT ${RINGKAS_SQL} FROM laporan l WHERE l.nisn = ?`).get(nisn);

function cariSiswaByNisn(req, res, { url }) {
  const nisn = url.searchParams.get('nisn') || '';
  if (!/^\d{10}$/.test(nisn)) throw new HttpError(400, 'NISN harus 10 digit angka.');
  const siswa = db.prepare('SELECT nisn, nama, kelas, hash IS NOT NULL AS punya_password FROM siswa WHERE nisn = ?').get(nisn);
  if (!siswa) throw new HttpError(404, 'NISN tidak ditemukan.');
  kirimJson(res, 200, { ...siswa, punya_password: Boolean(siswa.punya_password), ...ringkasan(nisn) });
}

// Profil murid yang sedang login: hanya miliknya sendiri
function profilSaya(req, res, { sesi }) {
  const siswa = db.prepare('SELECT nisn, nama, kelas FROM siswa WHERE nisn = ?').get(sesi.nisn);
  const riwayat = db.prepare(`
    SELECT l.jenis, l.masalah, l.poin, l.catatan, l.tanggal, g.nama AS guru
    FROM laporan l JOIN guru g ON g.id = l.guru_id
    WHERE l.nisn = ? ORDER BY l.tanggal DESC, l.id DESC LIMIT 500`).all(sesi.nisn);
  kirimJson(res, 200, { ...siswa, ...ringkasan(sesi.nisn), riwayat });
}

function cariRiwayat(req, res, { url }) {
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 3) throw new HttpError(400, 'Isi minimal 3 karakter (NISN atau nama).');
  const pola = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const baris = db.prepare(`
    SELECT s.nisn, s.nama, s.kelas, l.jenis, l.masalah, l.poin, l.catatan, l.tanggal, g.nama AS guru
    FROM siswa s
    LEFT JOIN laporan l ON l.nisn = s.nisn
    LEFT JOIN guru g ON g.id = l.guru_id
    WHERE s.nisn = ? OR s.nama LIKE ? ESCAPE '\\'
    ORDER BY s.nama, l.tanggal DESC, l.id DESC
    LIMIT 500`).all(q, pola);
  kirimJson(res, 200, baris);
}

// Semua siswa, diurutkan seperti chat WhatsApp: yang paling baru dilaporkan di paling atas.
// Siswa tanpa catatan ada di bawah, urut abjad.
function daftarSiswa(req, res) {
  const baris = db.prepare(`
    SELECT t.nisn, t.nama, t.kelas, t.punya_password, t.login_terakhir, t.pw_diganti, t.total, t.dosa, t.pahala, t.poin_dosa, t.poin_pahala, t.terakhir_id,
           lt.jenis AS jenis_terakhir, lt.masalah AS masalah_terakhir, lt.dibuat AS waktu_terakhir,
           gt.nama AS guru_terakhir
    FROM (
      SELECT s.nisn, s.nama, s.kelas, s.hash IS NOT NULL AS punya_password, s.login_terakhir, s.pw_diganti, ${RINGKAS_SQL}, MAX(l.id) AS terakhir_id
      FROM siswa s LEFT JOIN laporan l ON l.nisn = s.nisn
      GROUP BY s.nisn
    ) t
    LEFT JOIN laporan lt ON lt.id = t.terakhir_id
    LEFT JOIN guru gt ON gt.id = lt.guru_id
    ORDER BY t.terakhir_id IS NULL, t.terakhir_id DESC, t.nama
    LIMIT 1000`).all();
  kirimJson(res, 200, baris);
}

function statistikKegiatan(req, res, { url }) {
  const nisn = (url.searchParams.get('nisn') || '').trim();
  if (nisn && !/^\d{10}$/.test(nisn)) throw new HttpError(400, 'NISN harus 10 digit angka.');
  if (nisn && !db.prepare('SELECT 1 FROM siswa WHERE nisn = ?').get(nisn)) throw new HttpError(404, 'Siswa tidak ditemukan.');
  const syarat = nisn ? 'WHERE l.nisn = ?' : '';
  const nilai = nisn ? [nisn] : [];
  const bulan = db.prepare(`
    SELECT substr(l.tanggal, 1, 7) AS bulan,
           COALESCE(SUM(l.jenis = 'dosa'), 0) AS dosa,
           COALESCE(SUM(l.jenis = 'pahala'), 0) AS pahala
    FROM laporan l ${syarat}
    GROUP BY bulan ORDER BY bulan DESC LIMIT 6`).all(...nilai).reverse();
  const kategori = db.prepare(`
    SELECT l.masalah AS nama, l.jenis AS jenis, COUNT(*) AS jumlah, COALESCE(SUM(l.poin), 0) AS poin
    FROM laporan l ${syarat}
    GROUP BY l.jenis, l.masalah ORDER BY jumlah DESC, l.masalah LIMIT 6`).all(...nilai);
  const total = db.prepare(`
    SELECT COALESCE(SUM(l.jenis = 'dosa'), 0) AS dosa,
           COALESCE(SUM(l.jenis = 'pahala'), 0) AS pahala
    FROM laporan l ${syarat}`).get(...nilai);
  const terbaru = db.prepare(`
    SELECT l.id, l.nisn, s.nama, s.kelas, l.jenis, l.masalah, l.poin, l.tanggal, g.nama AS guru
    FROM laporan l
    JOIN siswa s ON s.nisn = l.nisn
    JOIN guru g ON g.id = l.guru_id
    ${syarat}
    ORDER BY l.tanggal DESC, l.id DESC LIMIT 8`).all(...nilai);
  kirimJson(res, 200, { nisn: nisn || null, bulan, kategori, total, terbaru });
}

// ---------- Handler API: kategori & aduan ----------
const bersihkan = (t, maks) => String(t || '').trim().replace(/\s+/g, ' ').slice(0, maks);

function poinValid(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new HttpError(400, 'Poin harus bilangan bulat 1–1000.');
  return n;
}
function namaKategoriValid(n) {
  const nama = bersihkan(n, 60);
  if (nama.length < 3) throw new HttpError(400, 'Nama kategori minimal 3 karakter.');
  return nama;
}
const pesanKategoriAda = () => new HttpError(409, 'Kategori dengan nama itu sudah ada. Pilih dari daftar, atau pakai nama lain.');

function daftarKategori(req, res) {
  kirimJson(res, 200, db.prepare(
    'SELECT id, jenis, nama, poin, aktif FROM kategori ORDER BY jenis, aktif DESC, poin DESC, nama').all());
}

async function tambahKategori(req, res) {
  const b = await bacaBody(req);
  if (!['pahala', 'dosa'].includes(b.jenis)) throw new HttpError(400, 'Jenis harus pahala atau dosa.');
  const nama = namaKategoriValid(b.nama), poin = poinValid(b.poin);
  try { db.prepare('INSERT INTO kategori (jenis, nama, poin) VALUES (?, ?, ?)').run(b.jenis, nama, poin); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw pesanKategoriAda(); throw e; }
  kirimJson(res, 201, { ok: true });
}

async function ubahKategori(req, res) {
  const b = await bacaBody(req);
  const k = db.prepare('SELECT * FROM kategori WHERE id = ?').get(Number(b.id));
  if (!k) throw new HttpError(404, 'Kategori tidak ditemukan.');
  const nama = b.nama === undefined ? k.nama : namaKategoriValid(b.nama);
  const poin = b.poin === undefined ? k.poin : poinValid(b.poin);
  const aktif = b.aktif === undefined ? k.aktif : (b.aktif ? 1 : 0);
  try { db.prepare('UPDATE kategori SET nama = ?, poin = ?, aktif = ? WHERE id = ?').run(nama, poin, aktif, k.id); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw pesanKategoriAda(); throw e; }
  kirimJson(res, 200, { ok: true });
}

async function simpanLaporan(req, res, { sesi }) {
  const b = await bacaBody(req);
  const nisn = String(b.nisn || '');
  const catatan = bersihkan(b.catatan, 200) || null;

  if (b.konfirmasi !== true) throw new HttpError(400, 'Konfirmasi akhir belum dilakukan.');
  if (!['pahala', 'dosa'].includes(b.jenis)) throw new HttpError(400, 'Jenis harus pahala atau dosa.');
  if (!tanggalValid(b.tanggal)) throw new HttpError(400, 'Tanggal tidak valid atau di masa depan.');
  if (!db.prepare('SELECT 1 FROM siswa WHERE nisn = ?').get(nisn)) throw new HttpError(404, 'Siswa tidak ditemukan.');

  // Poin selalu diambil dari database (kategori), bukan dari angka kiriman browser.
  let masalah, poin, kategoriId = null;
  if (b.kategori_id) {
    const k = db.prepare('SELECT * FROM kategori WHERE id = ? AND aktif = 1').get(Number(b.kategori_id));
    if (!k || k.jenis !== b.jenis) throw new HttpError(400, 'Kategori tidak valid untuk jenis ini.');
    ({ nama: masalah, poin } = k); kategoriId = k.id;
  } else if (b.lain && typeof b.lain === 'object') {
    masalah = namaKategoriValid(b.lain.nama); poin = poinValid(b.lain.poin);
    if (b.lain.simpan) {   // simpan juga sebagai kategori tetap
      try { kategoriId = Number(db.prepare('INSERT INTO kategori (jenis, nama, poin) VALUES (?, ?, ?)').run(b.jenis, masalah, poin).lastInsertRowid); }
      catch (e) { if (/UNIQUE/.test(e.message)) throw pesanKategoriAda(); throw e; }
    }
  } else {
    throw new HttpError(400, 'Pilih kategori aduan.');
  }

  try {
    db.prepare(`INSERT INTO laporan (nisn, guru_id, jenis, masalah, poin, kategori_id, catatan, tanggal)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(nisn, sesi.id, b.jenis, masalah, poin, kategoriId, catatan, b.tanggal);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) {
      throw new HttpError(409, 'Catatan yang sama (siswa, jenis, kategori, tanggal) sudah ada.');
    }
    throw e;
  }
  kirimJson(res, 201, { ok: true, poin });
}

// Gambar QR (SVG) berisi NISN siswa, untuk dicetak dan dipindai.
async function gambarQr(req, res, { url }) {
  const nisn = url.searchParams.get('nisn') || '';
  if (!/^\d{10}$/.test(nisn)) throw new HttpError(400, 'NISN harus 10 digit angka.');
  if (!QRCode) throw new HttpError(503, 'Paket QR belum terpasang. Jalankan: npm install');
  if (!db.prepare('SELECT 1 FROM siswa WHERE nisn = ?').get(nisn)) throw new HttpError(404, 'NISN tidak ditemukan.');
  const svg = await QRCode.toString(nisn, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
  res.end(svg);
}

// ---------- Scan QR dari gambar (dibaca oleh Python + OpenCV: scan_qr.py) ----------
const MAKS_GAMBAR = 12 * 1024 * 1024;

function bacaBodyMentah(req) {
  return new Promise((selesai, gagal) => {
    const potongan = [];
    let total = 0;
    req.on('data', p => {
      total += p.length;
      if (total > MAKS_GAMBAR) { req.destroy(); return gagal(new HttpError(413, 'Gambar terlalu besar (maks 12 MB).')); }
      potongan.push(p);
    });
    req.on('end', () => selesai(Buffer.concat(potongan)));
    req.on('error', () => gagal(new HttpError(400, 'Gambar gagal diterima.')));
  });
}

async function scanQr(req, res, { url }) {
  const gambar = await bacaBodyMentah(req);
  if (gambar.length < 100) throw new HttpError(400, 'Gambar kosong.');
  const berkas = path.join(os.tmpdir(), `qr-${crypto.randomBytes(8).toString('hex')}`);
  fs.writeFileSync(berkas, gambar);

  // Frame kamera: dikirim terus-menerus, dibaca oleh proses Python yang tetap hidup
  if (url.searchParams.get('cepat')) {
    let balas;
    try { balas = await bacaLewatLayanan('cepat', berkas); }
    finally { fs.unlink(berkas, () => {}); }
    if (balas === null) throw new HttpError(503, 'Python/OpenCV belum siap di server. Jalankan: npm run tes-qr');
    if (!balas.startsWith('OK\t')) throw new HttpError(422, 'Belum terbaca.');
    const isi = balas.slice(3).trim();
    if (!/^\d{10}$/.test(isi)) throw new HttpError(422, 'Itu bukan QR siswa.');
    return kirimJson(res, 200, { nisn: isi });
  }

  let hasil;
  try { hasil = await jalankanPython([berkas]); }
  finally { fs.unlink(berkas, () => {}); }

  if (!hasil.ada) throw new HttpError(503, 'Python belum terpasang di komputer server. Jalankan: npm run tes-qr');
  if (hasil.kode === 2) {
    console.error('scan_qr.py:', hasil.galat);
    throw new HttpError(503, 'Modul Python belum terpasang. Jalankan: pip install opencv-python-headless numpy');
  }
  if (hasil.kode === 3) throw new HttpError(415, 'Format gambar tidak didukung.');
  if (hasil.kode !== 0 || !hasil.keluar) throw new HttpError(422, 'QR tidak terbaca. Pakai gambar yang lebih jelas.');
  if (!/^\d{10}$/.test(hasil.keluar)) throw new HttpError(422, 'Itu bukan QR siswa.');
  kirimJson(res, 200, { nisn: hasil.keluar });
}

// ---------- Handler API: dashboard admin ----------
const jumlah = (sql, ...p) => db.prepare(sql).get(...p).n;

function adminStatistik(req, res) {
  let ukuran = 0;
  try { ukuran = fs.statSync(path.join(__dirname, 'data.db')).size; } catch {}
  kirimJson(res, 200, {
    guru: jumlah('SELECT COUNT(*) n FROM guru'),
    siswa: jumlah('SELECT COUNT(*) n FROM siswa'),
    siswa_tanpa_password: jumlah('SELECT COUNT(*) n FROM siswa WHERE hash IS NULL'),
    siswa_pernah_login: jumlah('SELECT COUNT(*) n FROM siswa WHERE login_terakhir IS NOT NULL'),
    laporan: jumlah('SELECT COUNT(*) n FROM laporan'),
    laporan_hari_ini: jumlah('SELECT COUNT(*) n FROM laporan WHERE tanggal = ?', hariIni()),
    poin_dosa: jumlah("SELECT COALESCE(SUM(poin),0) n FROM laporan WHERE jenis = 'dosa'"),
    poin_pahala: jumlah("SELECT COALESCE(SUM(poin),0) n FROM laporan WHERE jenis = 'pahala'"),
    kategori_aktif: jumlah('SELECT COUNT(*) n FROM kategori WHERE aktif = 1'),
    sesi_aktif: jumlah('SELECT COUNT(*) n FROM sesi WHERE kadaluarsa > ?', Date.now()),
    server: {
      node: process.version, uptime: Math.round(process.uptime()),
      memori_mb: Math.round(process.memoryUsage().rss / 1048576), db_kb: Math.round(ukuran / 1024),
      https: fs.existsSync(path.join(__dirname, 'cert', 'cert.pem')), waktu: new Date().toLocaleString('id-ID'),
    },
  });
}

const daftarGuru = (req, res) => kirimJson(res, 200, db.prepare(`
  SELECT g.id, g.username, g.nama, COUNT(l.id) AS laporan
  FROM guru g LEFT JOIN laporan l ON l.guru_id = g.id GROUP BY g.id ORDER BY g.nama`).all());

async function tambahGuru(req, res) {
  const b = await bacaBody(req);
  const nama = bersihkan(b.nama, 60), username = String(b.username || '').trim();
  if (nama.length < 3) throw new HttpError(400, 'Nama minimal 3 karakter.');
  if (!/^[a-z0-9_.]{3,20}$/i.test(username)) throw new HttpError(400, 'Username 3–20 karakter: huruf, angka, titik, atau _');
  if (/^\d{10}$/.test(username)) throw new HttpError(400, 'Username tidak boleh 10 digit angka (itu format NISN murid).');
  if (db.prepare('SELECT 1 FROM guru WHERE username = ?').get(username)) throw new HttpError(409, 'Username sudah dipakai.');
  const password = buatPassword(), salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO guru (username, nama, hash, salt) VALUES (?, ?, ?, ?)').run(username, nama, hash(password, salt), salt);
  kirimJson(res, 201, { username, nama, password });
}

async function ubahNamaGuru(req, res) {
  const b = await bacaBody(req);
  const nama = bersihkan(b.nama, 60);
  if (nama.length < 3) throw new HttpError(400, 'Nama minimal 3 karakter.');
  if (!db.prepare('UPDATE guru SET nama = ? WHERE id = ?').run(nama, Number(b.id)).changes) throw new HttpError(404, 'Guru tidak ditemukan.');
  kirimJson(res, 200, { ok: true });
}

async function resetPasswordGuru(req, res) {
  const b = await bacaBody(req);
  const g = db.prepare('SELECT id, username, nama FROM guru WHERE id = ?').get(Number(b.id));
  if (!g) throw new HttpError(404, 'Guru tidak ditemukan.');
  const password = buatPassword(), salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE guru SET hash = ?, salt = ? WHERE id = ?').run(hash(password, salt), salt, g.id);
  db.prepare('DELETE FROM sesi WHERE guru_id = ?').run(g.id);
  kirimJson(res, 200, { username: g.username, nama: g.nama, password });
}

async function hapusGuru(req, res) {
  const b = await bacaBody(req);
  const g = db.prepare('SELECT id FROM guru WHERE id = ?').get(Number(b.id));
  if (!g) throw new HttpError(404, 'Guru tidak ditemukan.');
  const n = jumlah('SELECT COUNT(*) n FROM laporan WHERE guru_id = ?', g.id);
  if (n) throw new HttpError(409, `Guru ini punya ${n} catatan aduan, jadi tidak bisa dihapus (riwayat siswa akan rusak).`);
  db.prepare('DELETE FROM guru WHERE id = ?').run(g.id);
  kirimJson(res, 200, { ok: true });
}

// Tambah siswa baru (password acak, tampil sekali) atau ubah nama/kelas siswa yang sudah ada.
async function simpanSiswa(req, res) {
  const b = await bacaBody(req);
  const nisn = String(b.nisn || '').trim(), nama = bersihkan(b.nama, 60), kelas = bersihkan(b.kelas, 30);
  if (!/^\d{10}$/.test(nisn)) throw new HttpError(400, 'NISN harus 10 digit angka.');
  if (nama.length < 3) throw new HttpError(400, 'Nama minimal 3 karakter.');
  if (!kelas) throw new HttpError(400, 'Kelas tidak boleh kosong.');
  if (db.prepare('SELECT 1 FROM siswa WHERE nisn = ?').get(nisn)) {
    db.prepare('UPDATE siswa SET nama = ?, kelas = ? WHERE nisn = ?').run(nama, kelas, nisn);
    return kirimJson(res, 200, { ok: true });
  }
  const password = buatPassword(), salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO siswa (nisn, nama, kelas, hash, salt) VALUES (?, ?, ?, ?, ?)').run(nisn, nama, kelas, hash(password, salt), salt);
  kirimJson(res, 201, { nisn, nama, kelas, password });
}

async function hapusSiswa(req, res) {
  const b = await bacaBody(req);
  const nisn = String(b.nisn || '');
  if (!db.prepare('SELECT 1 FROM siswa WHERE nisn = ?').get(nisn)) throw new HttpError(404, 'Siswa tidak ditemukan.');
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM laporan WHERE nisn = ?').run(nisn);
    db.prepare('DELETE FROM sesi WHERE nisn = ?').run(nisn);
    db.prepare('DELETE FROM siswa WHERE nisn = ?').run(nisn);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  kirimJson(res, 200, { ok: true });
}

function daftarLaporanAdmin(req, res, { url }) {
  const q = (url.searchParams.get('q') || '').trim();
  const pola = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  kirimJson(res, 200, db.prepare(`
    SELECT l.id, l.nisn, s.nama, s.kelas, l.jenis, l.masalah, l.poin, l.catatan, l.tanggal, g.nama AS guru
    FROM laporan l JOIN siswa s ON s.nisn = l.nisn JOIN guru g ON g.id = l.guru_id
    WHERE ? = '' OR s.nisn = ? OR s.nama LIKE ? ESCAPE '\\' OR l.masalah LIKE ? ESCAPE '\\'
    ORDER BY l.id DESC LIMIT 200`).all(q, q, pola, pola));
}

async function hapusLaporan(req, res) {
  const b = await bacaBody(req);
  if (!db.prepare('DELETE FROM laporan WHERE id = ?').run(Number(b.id)).changes) throw new HttpError(404, 'Catatan tidak ditemukan.');
  kirimJson(res, 200, { ok: true });
}

function keluarkanSemua(req, res, { sesi }) {
  const n = db.prepare('DELETE FROM sesi WHERE sid != ?').run(sesi.sid).changes;
  kirimJson(res, 200, { ok: true, dikeluarkan: Number(n) });
}

// Unduh cadangan database (salinan utuh data.db). Berisi hash password, simpan di tempat aman.
function unduhBackup(req, res) {
  const berkas = path.join(os.tmpdir(), `backup-${crypto.randomBytes(8).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${berkas.replace(/'/g, "''")}'`);
  res.on('close', () => fs.unlink(berkas, () => {}));
  kirimFile(res, berkas, 'application/octet-stream', {
    'Content-Disposition': `attachment; filename="backup-dosa-pahala-${hariIni()}.db"`, 'Cache-Control': 'no-store' });
}

// Daftar rute: "METHOD /path" -> handler
const RUTE_BEBAS = { 'POST /api/login': login, 'POST /api/login-admin': loginAdmin };
const RUTE_SEMUA = {                       // guru maupun murid, asal sudah login
  'GET /api/saya': saya,
  'POST /api/logout': logout,
  'POST /api/ganti-password': gantiPassword,
  'POST /api/ganti-nama': gantiNama,
};
const RUTE_GURU = {
  'GET /api/daftar': daftarSiswa,
  'GET /api/statistik': statistikKegiatan,
  'GET /api/cari': cariRiwayat,
  'GET /api/siswa': cariSiswaByNisn,
  'POST /api/laporan': simpanLaporan,
  'GET /api/kategori': daftarKategori,
  'POST /api/kategori': tambahKategori,
  'POST /api/kategori/ubah': ubahKategori,
  'POST /api/password-murid': buatPasswordMurid,
  'GET /api/qr': gambarQr,
  'POST /api/scan': scanQr,
};
const RUTE_MURID = { 'GET /api/profil': profilSaya };
const RUTE_ADMIN = {
  'GET /api/admin/statistik': adminStatistik,
  'GET /api/admin/guru': daftarGuru,
  'POST /api/admin/guru': tambahGuru,
  'POST /api/admin/guru/nama': ubahNamaGuru,
  'POST /api/admin/guru/reset': resetPasswordGuru,
  'POST /api/admin/guru/hapus': hapusGuru,
  'GET /api/admin/siswa': daftarSiswa,
  'POST /api/admin/siswa': simpanSiswa,
  'POST /api/admin/siswa/hapus': hapusSiswa,
  'POST /api/admin/siswa/reset': buatPasswordMurid,
  'GET /api/admin/laporan': daftarLaporanAdmin,
  'POST /api/admin/laporan/hapus': hapusLaporan,
  'GET /api/admin/kategori': daftarKategori,
  'POST /api/admin/kategori': tambahKategori,
  'POST /api/admin/kategori/ubah': ubahKategori,
  'POST /api/admin/keluarkan-semua': keluarkanSemua,
  'GET /api/admin/backup': unduhBackup,
};

async function tanganiApi(req, res, url) {
  const kunci = `${req.method} ${url.pathname}`;
  if (RUTE_BEBAS[kunci]) return RUTE_BEBAS[kunci](req, res, { url });

  const sesi = ambilSesi(req);
  if (!sesi) throw new HttpError(401, 'Belum login.');
  if (RUTE_SEMUA[kunci]) return RUTE_SEMUA[kunci](req, res, { url, sesi });

  const TABEL = { guru: RUTE_GURU, murid: RUTE_MURID, admin: RUTE_ADMIN };
  const peran = Object.keys(TABEL).find(p => TABEL[p][kunci]);
  if (!peran) throw new HttpError(404, 'Tidak ditemukan.');
  if (sesi.peran !== peran) throw new HttpError(403, 'Akun ini tidak punya akses ke data tersebut.');
  return TABEL[peran][kunci](req, res, { url, sesi });
}

// ---------- Halaman ----------
// Kirim file; kalau file tidak ada / tidak terbaca, balas 404 (jangan sampai server mati).
function kirimFile(res, lokasi, tipe, tambahan = {}) {
  const aliran = fs.createReadStream(lokasi);
  aliran.on('error', () => {
    if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Halaman tidak ditemukan.');
  });
  aliran.on('open', () => {
    res.writeHead(200, { 'Content-Type': tipe, ...tambahan });
    aliran.pipe(res);
  });
}

function alihkan(res, tujuan) {
  res.writeHead(302, { Location: tujuan });
  res.end();
}

function tanganiHalaman(req, res, url) {
  const rute = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (ALIAS_LAMA[rute]) return alihkan(res, ALIAS_LAMA[rute]);
  const statis = FILE_STATIS[rute];
  if (statis && statis.file) return kirimFile(res, statis.file, statis.tipe);

  const halaman = HALAMAN[rute];
  if (!halaman) { res.writeHead(404); return res.end('Halaman tidak ditemukan.'); }
  const tanpaCache = { 'Cache-Control': 'no-store' };
  const sesi = ambilSesi(req);

  if (halaman.portal) {                               // beranda: kalau sudah login, langsung ke halamannya
    if (sesi) return alihkan(res, BERANDA[sesi.peran]);
    return kirimFile(res, path.join(FOLDER_PUBLIK, halaman.file), 'text/html; charset=utf-8', tanpaCache);
  }
  if (!sesi) {                                        // belum login: /admin /guru /murid menampilkan form login sendiri
    if (halaman.masuk) return kirimFile(res, path.join(FOLDER_PUBLIK, halaman.masuk), 'text/html; charset=utf-8', tanpaCache);
    if (rute.startsWith('/guru/')) return alihkan(res, `/guru?next=${encodeURIComponent(rute)}`);
    return alihkan(res, '/');
  }
  if (halaman.peran !== 'semua' && halaman.peran !== sesi.peran) return alihkan(res, BERANDA[sesi.peran]);
  kirimFile(res, path.join(FOLDER_PUBLIK, halaman.file), 'text/html; charset=utf-8', tanpaCache);
}

// ---------- Server ----------
const tanganiPermintaan = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await tanganiApi(req, res, url);
    else tanganiHalaman(req, res, url);
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof HttpError) return kirimJson(res, e.status, { error: e.message });
    console.error(e);
    kirimJson(res, 500, { error: 'Terjadi kesalahan di server.' });
  }
};

if (!db.prepare('SELECT 1 FROM admin LIMIT 1').get()) console.log('! Belum ada akun admin. Buat dulu: npm run admin');

http.createServer(tanganiPermintaan).listen(PORT, () => {
  console.log('Server jalan. Buka link berikut:');
  console.log(`  Beranda (pilih peran)    : http://localhost:${PORT}/`);
  console.log(`  Murid                    : http://localhost:${PORT}/murid`);
  console.log(`  Guru                     : http://localhost:${PORT}/guru`);
  console.log(`  Admin                    : http://localhost:${PORT}/admin`);
});

// HTTPS (wajib agar kamera/scan QR jalan di HP). Buat sertifikat dulu: npm run cert
const PORT_HTTPS = process.env.PORT_HTTPS || 3443;
const alamatLan = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
const fileKey = path.join(__dirname, 'cert', 'key.pem');
const fileCert = path.join(__dirname, 'cert', 'cert.pem');
if (fs.existsSync(fileKey) && fs.existsSync(fileCert)) {
  https.createServer({ key: fs.readFileSync(fileKey), cert: fs.readFileSync(fileCert) }, tanganiPermintaan)
    .listen(PORT_HTTPS, () => console.log(`  HTTPS (kamera di HP)     : https://${alamatLan[0] || '<IP-komputer>'}:${PORT_HTTPS}/`));
} else {
  console.log('  (Scan QR lewat kamera di HP butuh HTTPS: jalankan "npm run cert" lalu start ulang)');
}

