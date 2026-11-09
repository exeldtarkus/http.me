# http.me

[English](README.md) | Bahasa Indonesia

HTTP client ringan untuk VS Code, ala Postman, dengan fokus **hemat RAM**: request disimpan sebagai file `.http` biasa di repository, lengkap dengan request editor, response viewer, collection, Environment, cookie, history, serta import / export Postman dan OpenAPI.

![Request dan response](images/screenshots/request.png)

## Fitur

- **Request editor** – method, URL dengan `{{variable}}`, query param, header, body (JSON, teks, XML, form, multipart dengan file, binary), 12 jenis authorization (Basic, Bearer, API key, OAuth 2.0, Digest, AWS Signature, …). Kirim dengan `Ctrl+Enter`, bisa di-cancel kapan saja, sampai 6 request berjalan paralel.
- **Response viewer** – JSON / XML / HTML / CSV, pencarian, header, cookie, timeline redirect, hasil test, dan console. Response besar (> 1 MB) tidak ditahan di memory: dibuka di editor.
- **Collection = file `.http`** – satu request per file (kompatibel REST Client / JetBrains), folder = folder biasa, jadi semuanya bisa di-review di Git. Sidebar dengan drag & drop, rename, duplicate, Copy as cURL / PowerShell, dan **Dashboard** yang menggabungkan Collections, Environments, dan Cookies dalam satu halaman.
- **Environment** – dev / uat / prod dengan key yang sama, `NULL` untuk nilai yang belum diisi, Globals, variable collection, nilai rahasia disimpan di SecretStorage VS Code (tidak pernah di file), serta import / export `http-client.env.json`.
- **Cookie dan sesi login** – cookie jar per Environment, login ulang otomatis saat sesi habis.
- **Request timeout** – default 10 menit; ubah lewat setting `httpme.request.timeout` (detik) atau `http.me: Set Request Timeout…`, atau timpa per request dengan `# @timeout <detik>`. Berlaku untuk request, request login, dan request token OAuth 2.0.
- **Script** – `pre-request.js` dan `post-request.js` per folder atau request dengan helper `httpme.*` dan test.
- **Import** – cURL, Postman Collection v2.0 / v2.1 (script ikut diterjemahkan), Postman Environment, OpenAPI 3.x / Swagger 2.0 (JSON atau YAML, dari file atau URL), dengan preview dan re-import dari sumbernya.
- **Export** – ke Postman Collection v2.1 atau OpenAPI 3.0.3 / 3.1.0 dengan pratinjau langsung, pilihan request, dan Environment sebagai file Postman atau JetBrains. Nilai rahasia tidak pernah ditulis kecuali Anda konfirmasi.
- **Hemat RAM** – tanpa dependency runtime selain `yaml` (dimuat hanya saat perlu), aktivasi malas, dan webview hanya untuk tab yang terlihat.

## Tangkapan layar

| Dashboard | Environments |
|---|---|
| ![Dashboard](images/screenshots/dashboard.png) | ![Editor Environment](images/screenshots/environment.png) |

| Export | Preview import |
|---|---|
| ![Export](images/screenshots/export.png) | ![Preview import](images/screenshots/import.png) |

## Mulai cepat

1. Buka sebuah folder lalu jalankan **http.me: New Request** (atau buat file `.http`).
2. Ketik URL, tekan **Send**, lalu **Save**: request tersimpan sebagai file `.http`.
3. Buat **Environment** (`http.me: New Environment`) dan pakai `{{baseUrl}}` di URL.
4. Punya collection Postman atau spec OpenAPI? Pakai **http.me: Import…**.
5. Buka **Dashboard** dengan `Ctrl+Alt+D` (`Cmd+Alt+D` di macOS).

### File `.http`

```http
### Create order
POST {{baseUrl}}/orders
Content-Type: application/json

{"items":[{"sku":"TSH-001","qty":2}]}
```

## Command dan shortcut

| Command | Shortcut |
|---|---|
| http.me: Send Request | `Ctrl+Enter` |
| http.me: Open Dashboard | `Ctrl+Alt+D` |
| http.me: Select Environment | `Ctrl+Alt+E` |
| http.me: Next / Previous Environment | `Ctrl+Alt+]` / `Ctrl+Alt+[` |
| http.me: Set Request Timeout… | Command Palette |
| http.me: Import… / Export… | Command Palette |

Semua command ada di kategori **http.me** pada Command Palette.

## Privasi

http.me tidak memakai telemetri dan hanya mengirim request ke tujuan yang Anda tentukan. Nilai rahasia tetap di SecretStorage VS Code; header `Authorization` dan cookie tidak disimpan di History.

## Masukan

Issue dan ide: <https://github.com/exeldtarkus/http.me/issues>
