localhost-cert.pem / localhost-key.pem: sertifikat self-signed KHUSUS TEST (http.test.ts, opsi # @insecure).
Bukan rahasia, tidak dipakai di luar test. Dibuat ulang:
openssl req -x509 -newkey rsa:2048 -nodes -days 36500 -subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" -keyout localhost-key.pem -out localhost-cert.pem
