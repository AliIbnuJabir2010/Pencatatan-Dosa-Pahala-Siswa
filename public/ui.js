// Fungsi umum untuk semua halaman.
const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => { const x = document.createElement(tag); if (cls) x.className = cls; if (txt != null) x.textContent = txt; return x; };
const fmtTgl = t => t.split('-').reverse().join('/');
const hariIni = () => new Date().toLocaleDateString('sv-SE');

// Panggil API (JSON). Sesi habis -> kembali ke halaman masuk.
async function api(url, opsi) {
  const r = await fetch(url, opsi);
  let d = {};
  try { d = await r.json(); } catch {}
  if (r.status === 401 && url !== '/api/login') { location = '/'; throw new Error('Sesi habis, silakan masuk lagi.'); }
  if (!r.ok) throw new Error(d.error || 'Gagal');
  return d;
}
const kirim = (url, data) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });

// Tombol "Keluar" (id="out")
function pasangKeluar() {
  const t = $('out');
  if (t) t.onclick = async e => { e.preventDefault(); await fetch('/api/logout', { method: 'POST' }); location = '/'; };
}

// Kotak ringkasan: poin dosa, poin pahala, jumlah catatan
function kartuRingkas(d, tambahan = []) {
  const grid = el('div', 'bio-grid');
  [...tambahan, ['Poin Dosa', d.poin_dosa, 'dosa'], ['Poin Pahala', d.poin_pahala, 'pahala'],
    ['Catatan Dosa', d.dosa + '×'], ['Catatan Pahala', d.pahala + '×']].forEach(([k, v, kls]) => {
    const c = el('div'); c.append(el('small', null, k), el('b', kls || null, String(v))); grid.append(c);
  });
  return grid;
}

// Tabel riwayat satu siswa (rows: baris dengan masalah/poin/tanggal/guru; baris tanpa masalah diabaikan)
function tabelRiwayat(rows) {
  const ada = rows.filter(x => x.masalah);
  if (!ada.length) return el('div', 'kosong', 'Belum ada catatan.');
  const tb = document.createElement('table'), hd = tb.createTHead().insertRow();
  ['Masalah', 'Poin', 'Tanggal', 'Guru'].forEach(h => hd.appendChild(el('th', null, h)));
  const body = tb.createTBody();
  ada.forEach(x => {
    const tr = body.insertRow(), m = tr.insertCell();
    m.append(el('span', 'b ' + x.jenis, x.jenis), ' ', x.masalah);
    if (x.catatan) m.append(el('div', 'sub', x.catatan));
    tr.insertCell().textContent = x.poin ? (x.jenis === 'dosa' ? '−' : '+') + x.poin : '–';
    tr.insertCell().textContent = fmtTgl(x.tanggal);
    tr.insertCell().textContent = x.guru;
  });
  const w = el('div', 'tabel'); w.appendChild(tb); return w;
}

// Kotak yang menampilkan password baru satu kali (info: {nisn, nama, password})
function kotakPassword(info) {
  const k = el('div', 'pwbox');
  const salin = el('button', 'ghost', 'Salin');
  salin.onclick = async () => { try { await navigator.clipboard.writeText(info.password); salin.textContent = 'Tersalin'; } catch { salin.textContent = 'Salin manual'; } };
  k.append(el('div', 'sub', 'Password baru untuk ' + info.nama + ' (username: ' + info.nisn + ')'),
           el('div', 'pw', info.password), salin,
           el('div', 'sub', 'Catat sekarang. Password tidak bisa dilihat lagi setelah halaman ini ditutup.'));
  return k;
}
