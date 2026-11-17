// Koneksi database SQLite + skema tabel.
// Memakai better-sqlite3; kalau tidak terpasang, otomatis memakai node:sqlite (Node 22.5+).
const path = require('path');
const crypto = require('crypto');

const FILE_DB = path.join(__dirname, 'data.db');

function bukaDatabase() {
  try {
    const Database = require('better-sqlite3');
    return new Database(FILE_DB);
  } catch {
    try {
      const { DatabaseSync } = require('node:sqlite');
      return new DatabaseSync(FILE_DB);
    } catch {
      console.error('Database tidak bisa dibuka.');
      console.error('Jalankan "npm install", atau pakai Node.js versi 22.13 ke atas.');
      process.exit(1);
    }
  }
}

const db = bukaDatabase();

// ---------- Migrasi database lama (aman dijalankan berulang) ----------
const kolom = tabel => db.prepare(`PRAGMA table_info(${tabel})`).all().map(k => k.name);
const tabelAda = nama => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nama));

// Sesi lama hanya untuk guru. Tabel diganti supaya bisa menampung guru dan murid
// (sesi hanya data login sementara: yang sedang login cukup masuk lagi).
if (tabelAda('sesi') && !(kolom('sesi').includes('peran') && kolom('sesi').includes('admin_id'))) db.exec('DROP TABLE sesi');

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS guru (
    id       INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    nama     TEXT NOT NULL,
    hash     TEXT NOT NULL,
    salt     TEXT NOT NULL
  );

  -- hash/salt kosong = murid belum punya password: password awalnya NISN
  CREATE TABLE IF NOT EXISTS siswa (
    nisn  TEXT PRIMARY KEY,
    nama  TEXT NOT NULL,
    kelas TEXT NOT NULL,
    hash  TEXT,
    salt  TEXT
  );

  -- Daftar kategori aduan beserta poinnya (bisa ditambah / diubah guru)
  CREATE TABLE IF NOT EXISTS kategori (
    id    INTEGER PRIMARY KEY,
    jenis TEXT NOT NULL CHECK (jenis IN ('pahala', 'dosa')),
    nama  TEXT NOT NULL,
    poin  INTEGER NOT NULL CHECK (poin BETWEEN 1 AND 1000),
    aktif INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_kategori ON kategori (jenis, lower(nama));

  CREATE TABLE IF NOT EXISTS laporan (
    id          INTEGER PRIMARY KEY,
    nisn        TEXT NOT NULL REFERENCES siswa(nisn),
    guru_id     INTEGER NOT NULL REFERENCES guru(id),
    jenis       TEXT NOT NULL CHECK (jenis IN ('pahala', 'dosa')),
    masalah     TEXT NOT NULL,
    tanggal     TEXT NOT NULL,
    dibuat      TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  -- Admin: pengelola dashboard pusat. Dibuat lewat terminal (npm run admin), login terpisah dari guru.
  CREATE TABLE IF NOT EXISTS admin (
    id       INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    nama     TEXT NOT NULL,
    hash     TEXT NOT NULL,
    salt     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sesi (
    sid        TEXT PRIMARY KEY,
    peran      TEXT NOT NULL CHECK (peran IN ('guru', 'murid', 'admin')),
    admin_id   INTEGER REFERENCES admin(id) ON DELETE CASCADE,
    guru_id    INTEGER REFERENCES guru(id) ON DELETE CASCADE,
    nisn       TEXT REFERENCES siswa(nisn) ON DELETE CASCADE,
    kadaluarsa INTEGER NOT NULL
  );

  -- Mencegah catatan ganda: siswa + jenis + aduan + tanggal yang sama
  CREATE UNIQUE INDEX IF NOT EXISTS uq_laporan
    ON laporan (nisn, jenis, lower(masalah), tanggal);
`);

// Kolom tambahan untuk database lama. Poin disimpan di setiap laporan (salinan),
// jadi mengubah poin kategori nanti tidak mengubah catatan yang sudah ada.
for (const [tabel, nama, definisi] of [
  ['siswa',   'hash',        'TEXT'],
  ['siswa',   'salt',        'TEXT'],
  ['siswa',   'login_terakhir', 'TEXT'],
  ['siswa',   'pw_diganti',  'INTEGER NOT NULL DEFAULT 0'],
  ['laporan', 'poin',        'INTEGER NOT NULL DEFAULT 0'],
  ['laporan', 'kategori_id', 'INTEGER'],
  ['laporan', 'catatan',     'TEXT'],
]) {
  if (!kolom(tabel).includes(nama)) db.exec(`ALTER TABLE ${tabel} ADD COLUMN ${nama} ${definisi}`);
}

// Kategori awal (hanya saat daftar masih kosong). Selain "Panjat pagar = 10",
// angkanya contoh saja: ubah lewat halaman Kategori.
if (db.prepare('SELECT COUNT(*) AS n FROM kategori').get().n === 0) {
  const tambah = db.prepare('INSERT INTO kategori (jenis, nama, poin) VALUES (?, ?, ?)');
  [
    ['dosa', 'Panjat pagar', 10],
    ['dosa', 'Cabut / bolos', 15],
    ['dosa', 'Terlambat', 5],
    ['dosa', 'Seragam tidak sesuai', 5],
    ['pahala', 'Juara lomba', 20],
    ['pahala', 'Prestasi akademik', 10],
    ['pahala', 'Membantu guru / sekolah', 5],
  ].forEach(k => tambah.run(...k));
}

const hash = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');

// Password acak 8 karakter, tanpa huruf/angka yang mudah tertukar (0 O 1 l I)
const HURUF_PASSWORD = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const buatPassword = (panjang = 8) =>
  Array.from({ length: panjang }, () => HURUF_PASSWORD[crypto.randomInt(HURUF_PASSWORD.length)]).join('');

module.exports = { db, hash, buatPassword };
