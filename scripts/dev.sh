#!/usr/bin/env bash
# Buka Extension Development Host (setara F5) dengan extension dari folder ini, tanpa install.
# run: npm run dev   (`npm run dev -- <folder>` untuk folder lain; default test-extension/ berisi contoh .http)
# Di WSL, `code` remote-cli tidak mendukung --extensionDevelopmentPath, jadi pakai `code` Windows (path Linux diubah otomatis oleh ekstensi Remote WSL).
# shortcut: jendela dev yang sudah terbuka hanya di-reload dengan folder lamanya (moonage memakai handler onUri, http.me tidak boleh); tutup dulu jendela dev bila ganti folder.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
folder="$(realpath "${1:-$root/test-extension}")"
if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
  wincode="$(ls -d /mnt/c/Users/*/AppData/Local/Programs/"Microsoft VS Code"/bin/code 2>/dev/null | head -1)"
  [[ -n "$wincode" ]] || { echo "[dev] VS Code Windows tidak ditemukan di /mnt/c/Users/*/AppData/Local/Programs" >&2; exit 1; }
  exec "$wincode" --extensionDevelopmentPath="$root" "$folder"
fi
exec code --extensionDevelopmentPath="$root" "$folder"
