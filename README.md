# TUNNEL

Publikasikan web lokal ke internet lewat **Cloudflare Tunnel**. Satu file, tanpa dependency.

```bash
node tunnel.js
```

Binary `cloudflared` diunduh otomatis (versi terbaru) ke `bin/` sesuai OS & arsitektur. Kalau binary sudah ada, langsung dipakai.

## Syarat

- Node.js 18+
- Windows / Linux / macOS

## 3 Mode

| Mode | Untuk | Keamanan |
| --- | --- | --- |
| **1. Token** | Produksi, domain tetap | **Paling aman (recommended)** |
| **2. Config / ingress** | Banyak hostname / service, pakai `config.yml` | Aman (named tunnel) |
| **3. Quick / dev** | Tes cepat, tanpa akun | Sementara, URL acak |

Jalankan `node tunnel.js`, lalu pilih nomor mode. Script akan:

1. mendeteksi port web yang sedang listening (atau tanya port),
2. menawarkan menjalankan `index.js` / `server.js` / `npm start` kalau belum ada server,
3. mengunduh `cloudflared` kalau belum ada,
4. membuka tunnel.

---

## Mode 1 - Token (recommended)

Paling aman karena tidak ada port yang diekspos langsung dan konfigurasi disimpan di dashboard Cloudflare.

**Buat tunnel:**

1. Buka [dash.cloudflare.com](https://dash.cloudflare.com) -> **Zero Trust** -> **Networks** -> **Tunnels**
2. **Create a tunnel** -> pilih **Cloudflared** -> beri nama
3. Copy **token** yang muncul
4. Di tab **Public Hostname**, tambahkan:
   - Subdomain: `app`
   - Domain: `domainkamu.com`
   - Service: `http://localhost:3000`

**Jalankan:**

```bash
node tunnel.js
# pilih 1, tempel token
```

Atau langsung:

```bash
node tunnel.js --mode token --token eyJhIjoi...
```

Token bisa juga disimpan permanen di `.env`:

```env
TUNNEL_TOKEN=eyJhIjoi...
```

Setelah itu cukup `node tunnel.js` dan pilih mode 1.

> `.env` jangan di-commit. Sudah ada di `.gitignore`.

---

## Mode 2 - Config / ingress

Pakai file `config.yml` milik cloudflared (biasanya di `.cloudflared/`). Cocok kalau mau beberapa hostname sekaligus.

**Buat tunnel + kredensial:**

```bash
bin/cloudflared tunnel login
bin/cloudflared tunnel create web-lokal
```

Perintah di atas membuat file kredensial di `~/.cloudflared/<UUID>.json`.

**Contoh `.cloudflared/config.yml`:**

```yaml
tunnel: web-lokal
credentials-file: C:\Users\kamu\.cloudflared\<UUID>.json

ingress:
  - hostname: app.domainkamu.com
    service: http://localhost:3000
  - hostname: api.domainkamu.com
    service: http://localhost:3001
  - service: http_status:404
```

**Arahkan DNS (sekali saja):**

```bash
bin/cloudflared tunnel route dns web-lokal app.domainkamu.com
bin/cloudflared tunnel route dns web-lokal api.domainkamu.com
```

**Jalankan:**

```bash
node tunnel.js
# pilih 2
```

Atau:

```bash
node tunnel.js --mode config --config .cloudflared/config.yml
```

Script mencari config di urutan ini:

1. `--config <path>`
2. `./.cloudflared/config.yml`
3. `~/.cloudflared/config.yml`

---

## Mode 3 - Quick / dev

Tanpa akun, tanpa domain. Cloudflare memberi URL acak `https://xxxx.trycloudflare.com` yang langsung aktif. Cocok untuk demo / tes di HP.

```bash
node tunnel.js
# pilih 3
```

Atau langsung:

```bash
node tunnel.js --mode quick --port 3000
```

URL publik akan muncul di terminal:

```
URL publik: https://xxxx-yyyy.trycloudflare.com
```

> URL berubah setiap kali dijalankan dan tunnel berhenti saat terminal ditutup. Jangan dipakai untuk produksi.

---

## Opsi CLI

```bash
node tunnel.js --help
```

| Opsi | Arti |
| --- | --- |
| `--mode <token\|config\|quick>` | pilih mode tanpa menu |
| `--token <token>` | token tunnel (atau env `TUNNEL_TOKEN`) |
| `--config <path>` | path `config.yml` |
| `--tunnel <name>` | nama tunnel untuk mode config |
| `--port, -p <n>` | port web lokal (default: auto-deteksi) |
| `--spawn` | jalankan `index.js` / `server.js` / `npm start` otomatis |
| `--no-spawn` | jangan jalankan server lokal |
| `--start, -y` | non-interaktif: auto mode (token > config > quick) + spawn |
| `--check` | cek / unduh binary saja lalu keluar |
| `--force-download` | unduh ulang `cloudflared` |
| `--help, -h` | bantuan |
| `--version, -v` | versi |

Contoh sekali jalan (server + tunnel):

```bash
node tunnel.js --mode quick --port 3000 --spawn
```

## Dipakai di projek lain

Projek web biasa cukup menambahkan catatan di README-nya:

> Butuh akses publik? Pakai [TUNNEL](https://github.com/IMikuae/TUNNEL).

Lalu di folder projek tersebut:

```bash
# copy tunnel.js ke root projek (atau jalankan dari folder ini)
node tunnel.js
```

`tunnel.js` selalu bekerja pada folder tempat ia dijalankan (`process.cwd()`), jadi `bin/`, `.env`, dan `index.js` yang dipakai adalah milik projek tersebut.

Tambahkan ke `.gitignore` projek:

```
bin/
.env
.cloudflared/
```

## Troubleshooting

| Masalah | Solusi |
| --- | --- |
| `binary belum ada` lalu gagal unduh | Cek internet, atau unduh manual dari [releases cloudflared](https://github.com/cloudflare/cloudflared/releases) lalu taruh di `bin/` |
| Port salah | `--port 3000` |
| Server tidak mau start | jalankan server manual, lalu `node tunnel.js --no-spawn` |
| Token invalid | buat ulang token di dashboard, pastikan tunnel masih aktif |
| Linux/macOS permission | `chmod +x bin/cloudflared` |
