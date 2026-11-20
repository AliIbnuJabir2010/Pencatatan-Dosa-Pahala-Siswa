// Mencari dan menjalankan Python di semua sistem (Windows, Linux, Termux).
// Di Windows "python3" sering cuma pintasan Microsoft Store (tanpa Python), jadi dicoba beberapa nama.
//   node python.js --tes   -> uji Python + OpenCV (dipakai: npm run tes-qr)
const path = require('path');
const { execFile, spawn } = require('child_process');

const SKRIP = path.join(__dirname, 'scan_qr.py');
const KANDIDAT = [['python3'], ['python'], ['py', '-3']];
let ingat = null; // perintah yang sudah terbukti jalan

// Hanya kode keluar 0-3 buatan scan_qr.py yang dianggap sah. Yang lain = Python tidak ada / pintasan Store.
function sah(kode, teks) {
  return [0, 1, 2, 3].includes(kode) && !/not found|was not found|Microsoft Store/i.test(teks);
}

function coba(perintah, args, batas) {
  const [nama, ...awal] = perintah;
  return new Promise(selesai => {
    execFile(nama, [...awal, ...args], { timeout: batas, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return selesai({ ada: false });
      const kode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      const keluar = String(stdout).trim(), galat = String(stderr).trim();
      selesai({ ada: sah(kode, keluar + ' ' + galat), kode, keluar, galat, perintah });
    });
  });
}

// Mengembalikan { ada:false } bila tidak ada Python yang berfungsi.
async function jalankanPython(args, batas = 20000) {
  const urutan = ingat ? [ingat, ...KANDIDAT] : KANDIDAT;
  for (const perintah of urutan) {
    const h = await coba(perintah, [SKRIP, ...args], batas);
    if (h.ada) { ingat = perintah; return h; }
  }
  return { ada: false };
}

// ---------- Layanan permanen untuk frame kamera ----------
// Satu proses Python dibiarkan hidup supaya OpenCV tidak di-import ulang untuk setiap frame.
let layananP = null;   // Promise<{ proses, antri }|null>

function mulaiLayanan() {
  const urutan = ingat ? [ingat, ...KANDIDAT] : KANDIDAT;
  const percobaan = i => new Promise(selesai => {
    if (i >= urutan.length) return selesai(null);
    const [nama, ...awal] = urutan[i];
    let proses;
    try { proses = spawn(nama, [...awal, SKRIP, '--layanan'], { windowsHide: true }); }
    catch { return selesai(percobaan(i + 1)); }
    let buf = '', siap = false, selesaiSudah = false;
    const lanjut = () => { if (!selesaiSudah) { selesaiSudah = true; selesai(percobaan(i + 1)); } };
    const batas = setTimeout(() => { proses.kill(); lanjut(); }, 20000);
    proses.on('error', () => { clearTimeout(batas); lanjut(); });          // ENOENT
    proses.on('exit', () => { clearTimeout(batas); if (!siap) lanjut(); });  // pintasan Store / modul kurang
    proses.stderr.on('data', () => {});
    proses.stdout.setEncoding('utf8');
    proses.stdout.on('data', d => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const baris = buf.slice(0, k).replace(/\r$/, ''); buf = buf.slice(k + 1);
        if (!siap) {
          if (baris === 'SIAP') {
            siap = true; clearTimeout(batas); ingat = urutan[i];
            const layanan = { proses, antri: [], sibuk: false, mati: false };
            proses.on('exit', () => { layanan.mati = true; layanan.antri.splice(0).forEach(t => t.selesai(null)); });
            layanan.baris = b => { const t = layanan.antri.shift(); if (t) { t.selesai(b); layanan.sibuk = false; kirimBerikut(layanan); } };
            proses.stdout.removeAllListeners('data');
            let sisa = buf;
            proses.stdout.on('data', dd => {
              sisa += dd;
              let n;
              while ((n = sisa.indexOf('\n')) >= 0) { const b = sisa.slice(0, n).replace(/\r$/, ''); sisa = sisa.slice(n + 1); layanan.baris(b); }
            });
            return selesai(layanan);
          }
        }
      }
    });
  });
  return percobaan(0);
}

function kirimBerikut(l) {
  if (l.sibuk || l.mati || !l.antri.length) return;
  l.sibuk = true;
  const t = l.antri[0];
  l.proses.stdin.write(t.perintah + '\n');
}

// Balasan: "OK\t<isi>" | "TIDAK" | "FORMAT" | null (Python tidak tersedia)
async function bacaLewatLayanan(mode, berkas) {
  if (!layananP) layananP = mulaiLayanan();
  let l = await layananP;
  if (l && l.mati) { layananP = mulaiLayanan(); l = await layananP; }
  if (!l) { layananP = null; return null; }
  return new Promise(selesai => {
    const batas = setTimeout(() => selesai(null), 15000);
    l.antri.push({ perintah: mode + '\t' + berkas, selesai: b => { clearTimeout(batas); selesai(b); } });
    kirimBerikut(l);
  });
}

module.exports = { jalankanPython, bacaLewatLayanan };

if (require.main === module && process.argv[2] === '--tes') {
  jalankanPython(['--tes'], 60000).then(h => {
    if (!h.ada) {
      console.log('Python TIDAK ditemukan (python3 / python / py sudah dicoba).');
      console.log('Pasang dari https://www.python.org/downloads/ dan centang "Add python.exe to PATH".');
      return process.exit(1);
    }
    console.log('Python dipakai:', h.perintah.join(' '));
    console.log(h.keluar || h.galat);
    if (h.kode === 2) console.log('Pasang modul:  ' + h.perintah.join(' ') + ' -m pip install -r requirements.txt');
    process.exit(h.kode);
  });
}
