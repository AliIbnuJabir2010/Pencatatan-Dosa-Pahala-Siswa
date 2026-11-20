// Membuat sertifikat HTTPS self-signed TANPA openssl (murni Node.js) supaya kamera jalan di HP.
//   npm run cert
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

// ---- penyusun DER minimal ----
const panjang = n => (n < 128 ? Buffer.from([n]) : (h => Buffer.concat([Buffer.from([0x80 | h.length]), h]))(Buffer.from(n.toString(16).padStart(n.toString(16).length + (n.toString(16).length % 2), '0'), 'hex')));
const tlv = (tag, ...isi) => { const b = Buffer.concat(isi); return Buffer.concat([Buffer.from([tag]), panjang(b.length), b]); };
const seq = (...x) => tlv(0x30, ...x);
const set = (...x) => tlv(0x31, ...x);
const oid = s => {
  const p = s.split('.').map(Number), b = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) { const t = [n & 0x7f]; for (let v = n >> 7; v; v >>= 7) t.unshift((v & 0x7f) | 0x80); b.push(...t); }
  return tlv(0x06, Buffer.from(b));
};
const bulat = buf => { let b = Buffer.from(buf); while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.slice(1); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); };
const utf8 = s => tlv(0x0c, Buffer.from(s, 'utf8'));
const waktu = d => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const bitString = b => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const ekspl = (n, ...x) => tlv(0xa0 | n, ...x);

const SHA256_RSA = seq(oid('1.2.840.113549.1.1.11'), tlv(0x05));
const nama = cn => seq(set(seq(oid('2.5.4.3'), utf8(cn))));

const ip = Object.values(os.networkInterfaces()).flat()
  .filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);

const san = seq(
  tlv(0x82, Buffer.from('localhost')),
  tlv(0x87, Buffer.from([127, 0, 0, 1])),
  ...ip.map(a => tlv(0x87, Buffer.from(a.split('.').map(Number)))),
);
const ekstensi = ekspl(3, seq(
  seq(oid('2.5.29.17'), tlv(0x04, san)),                                            // subjectAltName
  seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq())),          // basicConstraints (bukan CA)
));

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const mulai = new Date(Date.now() - 24 * 3600 * 1000), sampai = new Date(Date.now() + 3650 * 24 * 3600 * 1000);
const tbs = seq(
  ekspl(0, bulat(Buffer.from([2]))),                       // versi 3
  bulat(crypto.randomBytes(16)),                           // nomor seri
  SHA256_RSA, nama('dosa-pahala'),
  seq(waktu(mulai), waktu(sampai)),
  nama('dosa-pahala'),
  publicKey.export({ type: 'spki', format: 'der' }),
  ekstensi,
);
const tanda = crypto.sign('sha256', tbs, privateKey);
const der = seq(tbs, SHA256_RSA, bitString(tanda));

const pem = (label, b) => `-----BEGIN ${label}-----\n${b.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
const folder = path.join(__dirname, 'cert');
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, 'cert.pem'), pem('CERTIFICATE', der));
fs.writeFileSync(path.join(folder, 'key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));

console.log('Sertifikat dibuat di folder cert/ untuk: localhost, 127.0.0.1' + ip.map(a => ', ' + a).join(''));
console.log('Start ulang server, lalu di HP buka  https://' + (ip[0] || '<IP-komputer>') + ':3443');
console.log('Saat ada peringatan sertifikat, pilih "Lanjutkan" / "Advanced > Proceed" (normal untuk sertifikat buatan sendiri).');
