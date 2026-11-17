#!/usr/bin/env python3
"""Membaca QR dari file gambar.
  python3 scan_qr.py gambar.jpg   -> cetak isi QR (NISN)
  python3 scan_qr.py --tes        -> uji bahwa modul terpasang dan bisa membaca QR
Kode keluar: 0 = ketemu, 1 = QR tidak terbaca, 2 = modul belum terpasang, 3 = format gambar tidak didukung.
Pasang modul: pip install opencv-python-headless numpy"""
import sys

try:
    import cv2
    import numpy as np
except ImportError:
    sys.stderr.write("Modul belum terpasang. Jalankan: pip install opencv-python-headless numpy\n")
    sys.exit(2)


def buat_mesin():
    """Semua pembaca QR yang tersedia di versi OpenCV ini (yang lebih baru lebih kuat)."""
    mesin = [cv2.QRCodeDetector()]
    if hasattr(cv2, "QRCodeDetectorAruco"):
        mesin.insert(0, cv2.QRCodeDetectorAruco())
    return mesin


def coba(mesin, citra):
    for m in mesin:
        try:
            teks, _, _ = m.detectAndDecode(citra)
        except cv2.error:
            continue
        if teks:
            return teks.strip()
    return None


def varian(abu):
    """Beberapa versi gambar supaya QR buram / miring / tidak rata cahayanya tetap terbaca."""
    tinggi, lebar = abu.shape[:2]
    for maks in (1400, 900, 600, 2200):
        skala = min(maks / max(tinggi, lebar), 1.5)
        kecil = cv2.resize(abu, None, fx=skala, fy=skala,
                           interpolation=cv2.INTER_AREA if skala < 1 else cv2.INTER_CUBIC)
        yield kecil
        yield cv2.equalizeHist(kecil)
        yield cv2.adaptiveThreshold(kecil, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 10)
        yield cv2.bitwise_not(kecil)  # QR terbalik (putih di atas hitam)
        # bingkai putih: QR yang mepet tepi gambar jadi lebih mudah ditemukan
        yield cv2.copyMakeBorder(kecil, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)


def petak(abu, ukuran=1100):
    """Untuk foto besar dengan QR kecil: potong-potong pada resolusi asli (saling tumpang tindih)."""
    tinggi, lebar = abu.shape[:2]
    if max(tinggi, lebar) <= ukuran * 1.3:
        return
    langkah = ukuran // 2
    for y in range(0, max(tinggi - ukuran, 0) + langkah, langkah):
        for x in range(0, max(lebar - ukuran, 0) + langkah, langkah):
            irisan = abu[y:y + ukuran, x:x + ukuran]
            if irisan.size and min(irisan.shape[:2]) > 150:
                yield irisan
                yield cv2.copyMakeBorder(irisan, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)


def baca(lokasi):
    """Kembalikan (isi_qr, gambar_terbaca). gambar_terbaca False = format tidak didukung."""
    data = np.fromfile(lokasi, dtype=np.uint8)
    gambar = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if gambar is None:
        return None, False
    abu = cv2.cvtColor(gambar, cv2.COLOR_BGR2GRAY)
    mesin = buat_mesin()
    for v in varian(abu):
        hasil = coba(mesin, v)
        if hasil:
            return hasil, True
    for v in petak(abu):
        hasil = coba(mesin, v)
        if hasil:
            return hasil, True
    return None, True


def baca_cepat(lokasi):
    """Untuk frame kamera (dipanggil berkali-kali per detik): hanya beberapa variasi ringan."""
    data = np.fromfile(lokasi, dtype=np.uint8)
    gambar = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if gambar is None:
        return None, False
    mesin = buat_mesin()
    for v in (gambar, cv2.equalizeHist(gambar),
              cv2.copyMakeBorder(gambar, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255),
              cv2.resize(gambar, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)):
        hasil = coba(mesin, v)
        if hasil:
            return hasil, True
    return None, True


def layanan():
    """Proses yang tetap hidup: baca satu baris "mode<TAB>lokasi" lalu balas satu baris.
    Import OpenCV hanya sekali, jadi tiap frame kamera cepat dibaca."""
    print("SIAP", flush=True)
    for baris in sys.stdin:
        baris = baris.rstrip("\r\n")
        if "\t" not in baris:
            continue
        mode, lokasi = baris.split("\t", 1)
        try:
            isi, terbaca = (baca_cepat if mode == "cepat" else baca)(lokasi)
        except Exception:
            isi, terbaca = None, True
        print(("OK\t" + isi) if isi else ("TIDAK" if terbaca else "FORMAT"), flush=True)


def uji_sendiri():
    p = cv2.QRCodeEncoder_Params()
    qr = cv2.QRCodeEncoder.create(p).encode("3123456789")
    qr = cv2.copyMakeBorder(cv2.resize(qr, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST),
                            40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)
    import tempfile, os
    berkas = os.path.join(tempfile.gettempdir(), "uji_qr.png")
    cv2.imwrite(berkas, qr)
    hasil, _ = baca(berkas)
    os.unlink(berkas)
    print("OpenCV", cv2.__version__, "| mesin:", [type(m).__name__ for m in buat_mesin()])
    print("HASIL UJI:", "BERHASIL" if hasil == "3123456789" else "GAGAL (dibaca: %r)" % hasil)
    return 0 if hasil == "3123456789" else 1


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--layanan":
        layanan()
        sys.exit(0)
    if len(sys.argv) == 2 and sys.argv[1] == "--tes":
        sys.exit(uji_sendiri())
    if len(sys.argv) != 2:
        sys.stderr.write("Pakai: python3 scan_qr.py gambar.jpg\n")
        sys.exit(1)
    isi, terbaca = baca(sys.argv[1])
    if isi:
        print(isi)
        sys.exit(0)
    sys.exit(1 if terbaca else 3)
