// Fungsi umum untuk semua halaman.
const $ = id => document.getElementById(id);
const el = (tag, cls, txt) => { const x = document.createElement(tag); if (cls) x.className = cls; if (txt != null) x.textContent = txt; return x; };
const fmtTgl = t => t.split('-').reverse().join('/');
const hariIni = () => new Date().toLocaleDateString('sv-SE');
const inisial = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase();

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

function pasangNavigasi() {
  document.querySelectorAll('.top a[href], .menu-panel a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (href && href !== '#' && href === location.pathname) a.classList.add('aktif');
  });
}

function pasangMenu() {
  const top = document.querySelector('.top'), h1 = top && top.querySelector('h1');
  if (!h1 || !h1.querySelector('#out')) return;

  const tudung = el('div', 'menu-tudung');
  tudung.id = 'menuTudung';
  const panel = el('aside', 'menu-panel');
  panel.id = 'menuPanel';
  panel.setAttribute('aria-label', 'Menu');
  panel.setAttribute('aria-hidden', 'true');
  const tombol = el('button', 'menu-btn');
  tombol.id = 'menuBtn'; tombol.type = 'button';
  tombol.setAttribute('aria-label', 'Menu');
  tombol.setAttribute('aria-expanded', 'false');
  tombol.setAttribute('aria-controls', 'menuPanel');
  tombol.append(el('span'), el('span'), el('span'));

  const kepala = el('div', 'menu-kepala');
  const judul = h1.querySelector('span');
  kepala.append(el('div', 'menu-judul', judul ? judul.textContent.trim() : 'Menu'));
  const dekat = el('button', 'menu-dekat');
  dekat.type = 'button'; dekat.textContent = '×'; dekat.setAttribute('aria-label', 'Tutup menu');
  kepala.append(dekat);
  const isi = el('nav', 'menu-isi');
  const kaki = el('div', 'menu-kaki');

  const tautan = [...h1.querySelectorAll('a[href]')];
  const induk = new Set(tautan.map(a => a.parentElement));
  const keluar = tautan.find(a => a.id === 'out');
  tautan.forEach(a => {
    if (a.id === 'out' || a.getAttribute('href') === '/akun') return a.remove();
    isi.append(a);
  });
  const grup = el('div', 'menu-grup');
  grup.append(el('div', 'menu-label', 'Pengaturan'));
  [['Ganti nama', '/akun#nama'], ['Ganti password', '/akun#password']].forEach(([teks, href]) => {
    const a = el('a', null, teks); a.href = href; grup.append(a);
  });
  kaki.append(grup);
  if (keluar) kaki.append(keluar);
  induk.forEach(s => {
    if (s && s.id !== 'siapa' && !s.textContent.trim() && !s.children.length) s.remove();
  });
  panel.append(kepala, isi, kaki);

  const buka = () => {
    panel.classList.add('buka'); tudung.classList.add('buka');
    tombol.classList.add('buka'); document.body.classList.add('menu-terbuka');
    tombol.setAttribute('aria-expanded', 'true');
    panel.setAttribute('aria-hidden', 'false');
  };
  const tutup = () => {
    panel.classList.remove('buka'); tudung.classList.remove('buka');
    tombol.classList.remove('buka'); document.body.classList.remove('menu-terbuka');
    tombol.setAttribute('aria-expanded', 'false');
    panel.setAttribute('aria-hidden', 'true');
  };
  tombol.onclick = e => {
    e.stopPropagation();
    panel.classList.contains('buka') ? tutup() : buka();
  };
  dekat.onclick = tutup;
  tudung.onclick = tutup;
  panel.onclick = e => { if (e.target.closest('a')) tutup(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') tutup(); });
  (top.querySelector('.top-in') || top).append(tombol);
  document.body.append(tudung, panel);
}

document.addEventListener('DOMContentLoaded', () => { pasangMenu(); pasangNavigasi(); });

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
