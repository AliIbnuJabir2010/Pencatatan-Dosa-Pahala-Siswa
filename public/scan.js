// Pemindai QR siswa (isi QR = NISN), dipakai di halaman Siswa dan halaman Aduan.
// Butuh ui.js dan elemen: #bq (buka kamera) #finder #vid #petunjuk #tutup #drop #foto
//
//   pasangScan({ pesan: 'id-elemen-pesan', mulai: () => {...}, hasil: nisn => {...} })
//
// Kamera: hanya bagian tengah gambar (sesuai kotak) yang dibaca. Cara baca dipilih otomatis:
//   1) BarcodeDetector bawaan browser  2) jsQR (kalau terpasang)  3) dikirim ke Python di server.
// Gambar: dikirim ke server (Python); cadangan: dibaca di browser dengan jsQR.
function pasangScan({ pesan, mulai = () => {}, hasil }) {
  const tulis = t => { $(pesan).textContent = t; };
  const vid = $('vid'), potong = document.createElement('canvas'), pctx = potong.getContext('2d', { willReadFrequently: true });
  let stream = null, penunda = null, detektor = null, pesanTimer = null;
  const NISN = /^\d{10}$/;

  if ('BarcodeDetector' in window) {
    BarcodeDetector.getSupportedFormats().then(f => { if (f.includes('qr_code')) detektor = new BarcodeDetector({ formats: ['qr_code'] }); }).catch(() => {});
  }
  const petunjuk = (t, bahaya) => { const e = $('petunjuk'); e.textContent = t; e.classList.toggle('salah', !!bahaya); };
  const kirimScan = (blob, cepat) => fetch('/api/scan' + (cepat ? '?cepat=1' : ''), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: blob });

  // ---------- gambar ----------
  async function bacaDiBrowser(file) {
    if (typeof jsQR === 'undefined') return null;
    const g = await createImageBitmap(file);
    for (const maks of [1000, 600, 1600, 400]) {
      const skala = Math.min(1, maks / Math.max(g.width, g.height));
      const w = Math.round(g.width * skala), h = Math.round(g.height * skala);
      potong.width = w; potong.height = h; pctx.drawImage(g, 0, 0, w, h);
      const r = jsQR(pctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
      if (r) return r.data.trim();
    }
    return null;
  }

  // Ubah gambar apa pun (terutama SVG hasil simpan dari halaman QR) menjadi PNG di browser.
  async function jadiPng(file) {
    const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
    const url = URL.createObjectURL(svg ? new Blob([file], { type: 'image/svg+xml' }) : file);
    try {
      const img = new Image(); img.src = url; await img.decode();
      let w, h;
      if (svg) { w = h = 900; }   // QR berbentuk persegi; ukuran SVG tanpa width/height tidak bisa diandalkan
      else { const k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight)); w = Math.round(img.naturalWidth * k); h = Math.round(img.naturalHeight * k); }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0, w, h);
      return await new Promise((ok, gagal) => c.toBlob(b => b ? ok(b) : gagal(new Error('x')), 'image/png'));
    } finally { URL.revokeObjectURL(url); }
  }

  async function prosesGambar(file) {
    tulis(''); mulai();
    if (!file || !(file.type.startsWith('image/') || /\.(svg|png|jpe?g|webp|bmp|gif|heic)$/i.test(file.name))) return tulis('Pilih file gambar.');
    $('drop').classList.add('sibuk'); tulis('Membaca QR...');
    try {
      const svg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
      let kirimBlob = file;
      if (svg) kirimBlob = await jadiPng(file);
      let r = await kirimScan(kirimBlob);
      if (r.status === 415 && !svg) { kirimBlob = await jadiPng(file); r = await kirimScan(kirimBlob); }   // format asing: ubah ke PNG lalu coba lagi
      if (r.status === 401) return (location = '/');
      let d = {}; try { d = await r.json(); } catch {}
      if (r.ok) { tulis(''); return hasil(d.nisn); }
      if (r.status === 503) {            // server belum bisa baca: coba di browser
        const t = await bacaDiBrowser(kirimBlob);
        if (t && NISN.test(t)) { tulis(''); return hasil(t); }
      }
      tulis(d.error || 'QR tidak terbaca.');
    } catch { tulis('Gambar tidak bisa dibuka. Coba format lain (PNG/JPG).'); }
    finally { $('drop').classList.remove('sibuk'); }
  }

  // ---------- kamera ----------
  function ambilPotongan() {
    const vw = vid.videoWidth, vh = vid.videoHeight, sisi = Math.min(vw, vh) * 0.78;   // area baca sedikit lebih luas dari kotak
    const out = Math.min(720, Math.round(sisi));
    potong.width = potong.height = out;
    pctx.drawImage(vid, (vw - sisi) / 2, (vh - sisi) / 2, sisi, sisi, 0, 0, out, out);
    return out;
  }

  async function bacaPotongan() {
    const out = ambilPotongan();
    if (detektor) { try { const h = await detektor.detect(potong); return h.length ? h[0].rawValue.trim() : null; } catch {} }
    if (typeof jsQR !== 'undefined') {
      const h = jsQR(pctx.getImageData(0, 0, out, out).data, out, out, { inversionAttempts: 'attemptBoth' });
      return h ? h.data.trim() : null;
    }
    const blob = await new Promise(ok => potong.toBlob(ok, 'image/jpeg', 0.85));
    const r = await kirimScan(blob, true);
    if (r.status === 401) { location = '/'; return null; }
    if (r.status === 503) { const d = await r.json(); throw new Error(d.error); }
    if (r.ok) return (await r.json()).nisn;
    if (r.status === 422) { const d = await r.json(); if (/bukan QR siswa/.test(d.error)) return 'BUKAN'; }
    return null;
  }

  function tutupKamera() {
    clearTimeout(penunda); clearTimeout(pesanTimer);
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; vid.srcObject = null; $('finder').hidden = true; $('tutup').hidden = true; $('bq').hidden = false;
  }

  async function putar() {
    if (!stream) return;
    let teks = null;
    try { if (vid.readyState >= 2 && vid.videoWidth) teks = await bacaPotongan(); }
    catch (e) { tutupKamera(); return tulis(e.message); }
    if (!stream) return;
    if (teks === 'BUKAN' || (teks && !NISN.test(teks))) {
      petunjuk('Itu bukan QR siswa. Coba QR lain.', true);
      clearTimeout(pesanTimer); pesanTimer = setTimeout(() => petunjuk('Arahkan QR ke tengah kotak'), 1800);
    } else if (teks) {
      if (navigator.vibrate) navigator.vibrate(60);
      tutupKamera(); return hasil(teks);
    }
    penunda = setTimeout(putar, detektor || typeof jsQR !== 'undefined' ? 120 : 250);
  }

  function pesanKamera(e) {
    switch (e && e.name) {
      case 'NotAllowedError': case 'SecurityError':
        return 'Izin kamera ditolak. Ketuk ikon gembok/pengaturan di sebelah alamat web, pilih Izinkan Kamera, lalu coba lagi.';
      case 'NotFoundError': case 'OverconstrainedError':
        return 'Kamera tidak ditemukan di perangkat ini.';
      case 'NotReadableError': case 'AbortError':
        return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi itu (atau tab lain yang memakai kamera), lalu coba lagi.';
      default: return 'Kamera gagal dibuka (' + ((e && e.name) || 'tidak diketahui') + '). Pakai "Scan QR dari gambar" di bawah.';
    }
  }

  $('bq').onclick = async () => {
    tulis(''); mulai();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      return tulis('Kamera diblokir browser karena alamat ini bukan HTTPS (alamat sekarang: ' + location.origin + '). Buka https://' + location.hostname + ':3443 — buat sertifikat dulu dengan "npm run cert". Sementara itu bisa pakai "Scan QR dari gambar" di bawah.');
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } }); }
    catch (e) { return tulis(pesanKamera(e)); }
    vid.srcObject = stream; $('finder').hidden = false; $('tutup').hidden = false; $('bq').hidden = true;
    petunjuk('Arahkan QR ke tengah kotak');
    try { await vid.play(); } catch {}
    putar();
  };
  $('tutup').onclick = tutupKamera;
  document.addEventListener('visibilitychange', () => { if (document.hidden && stream) tutupKamera(); });

  $('foto').onchange = e => { const f = e.target.files[0]; e.target.value = ''; prosesGambar(f); };
  $('drop').addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('tarik'); });
  $('drop').addEventListener('dragleave', () => $('drop').classList.remove('tarik'));
  $('drop').addEventListener('drop', e => { e.preventDefault(); $('drop').classList.remove('tarik'); prosesGambar(e.dataTransfer.files[0]); });
  document.addEventListener('paste', e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) prosesGambar(item.getAsFile());
  });
}
