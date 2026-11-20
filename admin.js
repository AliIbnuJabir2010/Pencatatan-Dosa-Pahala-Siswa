// Menambah data lewat terminal, satu pertanyaan satu per satu.
//   npm run guru    -> tambah akun guru
//   npm run siswa   -> tambah / ubah data siswa
const crypto = require('crypto');
const readline = require('readline');
const { db, hash, buatPassword } = require('./db');

// ---------- Input terminal ----------
const TTY = process.stdin.isTTY;
let barisPipa;

function keluar() {
  console.log('\nDibatalkan.');
  process.exit(0);
}

// Input dari pipa/file (dipakai kalau bukan terminal interaktif)
async function bacaPipa(label) {
  process.stdout.write(label);
  barisPipa ??= readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const { value, done } = await barisPipa.next();
  if (done) keluar();
  console.log();
  return value.trim();
}

// Input terminal interaktif; password ditampilkan sebagai bintang
function bacaTerminal(label, rahasia) {
  return new Promise(selesai => {
    const stdin = process.stdin;
    let isi = '';
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();

    const saatTombol = potongan => {
      for (const c of potongan) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', saatTombol);
          process.stdout.write('\n');
          return selesai(isi.trim());
        }
        if (c === '\u0003') keluar();                       // Ctrl+C
        if (c === '\u007f' || c === '\b') {                 // Backspace
          if (isi.length) { isi = isi.slice(0, -1); process.stdout.write('\b \b'); }
        } else if (c >= ' ') {
          isi += c;
          process.stdout.write(rahasia ? '*' : c);
        }
      }
    };
    stdin.on('data', saatTombol);
  });
}

const tanya = (label, rahasia = false) => (TTY ? bacaTerminal(label, rahasia) : bacaPipa(label));

// Ulangi pertanyaan sampai jawabannya lolos pengecekan (cek mengembalikan pesan error)
async function tanyaValid(label, cek, rahasia = false) {
  for (;;) {
    const jawaban = await tanya(label, rahasia);
    const pesan = cek(jawaban);
    if (!pesan) return jawaban;
    console.log('  ! ' + pesan);
  }
}

async function tanyaYa(label) {
  const j = (await tanya(`${label} (y/t): `)).toLowerCase();
  return j === 'y' || j === 'ya';
}

// ---------- Tambah guru ----------
async function tambahGuru() {
  const nama = await tanyaValid('Nama lengkap guru : ', v => v.length < 3 && 'Minimal 3 karakter.');
  const username = await tanyaValid('Username          : ', v => {
    if (!/^[a-z0-9_.]{3,20}$/i.test(v)) return 'Username 3–20 karakter: huruf, angka, titik, atau _';
    if (/^\d{10}$/.test(v)) return 'Username tidak boleh 10 digit angka (itu format NISN murid).';
    if (db.prepare('SELECT 1 FROM guru WHERE username = ?').get(v)) return 'Username sudah dipakai.';
  });
  const password = await tanyaValid('Password (min 6)   : ', v => v.length < 6 && 'Password minimal 6 karakter.', true);
  await tanyaValid('Ulangi password    : ', v => v !== password && 'Password tidak sama.', true);

  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO guru (username, nama, hash, salt) VALUES (?, ?, ?, ?)')
    .run(username, nama, hash(password, salt), salt);
  console.log(`\n✔ Akun guru "${username}" (${nama}) dibuat.`);
}

// ---------- Tambah admin ----------
async function tambahAdmin() {
  const nama = await tanyaValid('Nama lengkap admin : ', v => v.length < 3 && 'Minimal 3 karakter.');
  const username = await tanyaValid('Username           : ', v => {
    if (!/^[a-z0-9_.]{3,20}$/i.test(v)) return 'Username 3–20 karakter: huruf, angka, titik, atau _';
    if (/^\d{10}$/.test(v)) return 'Username tidak boleh 10 digit angka (itu format NISN murid).';
    if (db.prepare('SELECT 1 FROM admin WHERE username = ?').get(v)) return 'Username sudah dipakai.';
  });
  const password = await tanyaValid('Password (min 8)    : ', v => v.length < 8 && 'Password admin minimal 8 karakter.', true);
  await tanyaValid('Ulangi password     : ', v => v !== password && 'Password tidak sama.', true);
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO admin (username, nama, hash, salt) VALUES (?, ?, ?, ?)').run(username, nama, hash(password, salt), salt);
  console.log(`\n✔ Akun admin "${username}" (${nama}) dibuat. Login di /admin/masuk`);
}

// ---------- Tambah / ubah siswa ----------
async function tambahSiswa() {
  const nisn = await tanyaValid('NISN (10 digit)       : ', v => !/^\d{10}$/.test(v) && 'NISN harus 10 digit angka.');
  const lama = db.prepare('SELECT nama, kelas FROM siswa WHERE nisn = ?').get(nisn);
  if (lama) {
    console.log(`  NISN sudah terdaftar: ${lama.nama} (${lama.kelas})`);
    if (!(await tanyaYa('  Ubah data siswa ini?'))) return;
  }
  const nama = await tanyaValid('Nama lengkap           : ', v => v.length < 3 && 'Minimal 3 karakter.');
  const kelas = await tanyaValid('Kelas (mis. XI IPA 2) : ', v => !v && 'Kelas tidak boleh kosong.');

  // Login murid: username = NISN, password milik murid sendiri.
  // Dikosongkan = dibuatkan password acak (siswa baru / belum punya) atau password lama dibiarkan.
  const punya = db.prepare('SELECT hash FROM siswa WHERE nisn = ?').get(nisn);
  let password = await tanyaValid('Password murid (kosong = buat acak / tidak diubah): ',
    v => v && v.length < 6 && 'Password minimal 6 karakter (atau kosongkan).', true);
  const acak = !password && !(punya && punya.hash);
  if (acak) password = buatPassword();
  const salt = password ? crypto.randomBytes(16).toString('hex') : null;

  // UPSERT: aman walau siswa sudah punya catatan aduan
  db.prepare(`INSERT INTO siswa (nisn, nama, kelas, hash, salt) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(nisn) DO UPDATE SET nama = excluded.nama, kelas = excluded.kelas,
                hash = COALESCE(excluded.hash, siswa.hash), salt = COALESCE(excluded.salt, siswa.salt)`)
    .run(nisn, nama, kelas, password ? hash(password, salt) : null, salt);
  console.log(`\n✔ Siswa disimpan: ${nama} — ${kelas}`);
  if (acak) {
    console.log(`  Login murid  : NISN ${nisn}`);
    console.log(`  Password     : ${password}   <- catat & berikan ke murid, tidak bisa dilihat lagi`);
  }
}

// ---------- Jalankan ----------
async function main() {
  const perintah = { guru: tambahGuru, siswa: tambahSiswa, admin: tambahAdmin }[process.argv[2]];
  if (!perintah) {
    console.log('Pakai:\n  npm run admin\n  npm run guru\n  npm run siswa');
    return;
  }
  do {
    console.log();
    await perintah();
  } while (await tanyaYa('\nTambah lagi?'));
  console.log('Selesai.');
}

main().then(() => process.exit(0));
