// Build VSIX lalu install ke VS Code lokal, hanya jika versi di package.json berbeda dari yang terpasang.
// Di WSL: dipasang ke VS Code Server WSL (`code`) DAN ke profile Windows (code.cmd Windows lewat cmd.exe).
// run: npm run install:local   (-- --force = pasang ulang walau versi sama; -- --profile http = profile VS Code, WSL & Windows)
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseProfile, profileArgs, detectProfile } = require('./install-local-profile');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const id = `${pkg.publisher}.${pkg.name}`;
const force = process.argv.includes('--force');
// profile yang sama untuk WSL & Windows (CLI tidak tahu profile window yang aktif)
const profile = parseProfile(process.argv.slice(2), process.env) ?? autoProfile();
const pArgs = profileArgs(profile);
const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);

/** WSL: ambil profile window VS Code Windows untuk folder ini dari storage.json (tidak ada = Default) */
function autoProfile() {
  try {
    const users = '/mnt/c/Users';
    const f = (fs.existsSync(users) ? fs.readdirSync(users) : [])
      .map((u) => path.join(users, u, 'AppData/Roaming/Code/User/globalStorage/storage.json')).find((p) => fs.existsSync(p));
    if (!process.env.WSL_DISTRO_NAME || !f) return undefined;
    const name = detectProfile(JSON.parse(fs.readFileSync(f, 'utf8')), process.env.WSL_DISTRO_NAME, root);
    if (name) console.log(`[install-local] profile terdeteksi dari VS Code: ${name}`);
    return name;
  } catch (e) {
    console.error(`[install-local] ERROR deteksi profile gagal, pakai Default: ${e.message}\n${e.stack}`);
    return undefined;
  }
}

const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

/** VS Code Windows dari WSL: code.cmd dijalankan lewat cmd.exe dari folder Windows (cmd.exe menolak cwd UNC \\wsl$) */
function windowsTarget() {
  if (!process.env.WSL_DISTRO_NAME) return undefined;
  const users = '/mnt/c/Users';
  const cmd = (fs.existsSync(users) ? fs.readdirSync(users) : [])
    .map((u) => path.join(users, u, 'AppData/Local/Programs/Microsoft VS Code/bin/code.cmd'))
    .find((p) => fs.existsSync(p));
  if (!cmd) {
    console.log('[install-local] VS Code Windows tidak ditemukan di /mnt/c/Users/*/AppData/Local/Programs, profile Windows dilewati.');
    return undefined;
  }
  const win = (p) => execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();
  const codeCmd = (args, opts) => execFileSync('cmd.exe', ['/d', '/c', win(cmd), ...args], { cwd: '/mnt/c', ...opts });
  return {
    name: 'Windows',
    list: () => codeCmd(['--list-extensions', '--show-versions', ...pArgs], { encoding: 'utf8' }),
    install: () => codeCmd(['--install-extension', win(vsix), '--force', ...pArgs], { stdio: 'inherit' }),
  };
}

const targets = [
  {
    name: process.env.WSL_DISTRO_NAME ? 'WSL' : 'local',
    list: () => execSync(['code', '--list-extensions', '--show-versions', ...pArgs.map((a) => JSON.stringify(a))].join(' '), { cwd: root, encoding: 'utf8' }),
    install: () => run(['code', '--install-extension', JSON.stringify(vsix), '--force', ...pArgs.map((a) => JSON.stringify(a))].join(' ')),
  },
  windowsTarget(),
].filter(Boolean);

function installedVersion(t) {
  try {
    const line = t.list().split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${id.toLowerCase()}@`));
    return line?.split('@')[1];
  } catch (e) {
    console.error(`[install-local] ERROR daftar extension ${t.name} gagal: ${e.message}\n${e.stack}`);
    return undefined; // tidak bisa dicek: dianggap perlu dipasang
  }
}

const todo = targets.map((t) => ({ t, installed: installedVersion(t) })).filter(({ t, installed }) => {
  if (installed === pkg.version && !force) {
    console.log(`[install-local] ${t.name}: ${id}@${pkg.version} sudah terpasang. Tidak melakukan apa-apa.`);
    return false;
  }
  console.log(`[install-local] ${t.name}${profile ? ` (profile ${profile})` : ''}: ${id} ${installed ?? 'belum terpasang'} -> ${pkg.version}`);
  return true;
});
if (!todo.length) {
  console.log('[install-local] Naikkan version di package.json (npm version patch), atau jalankan dengan -- --force.');
  process.exit(0);
}

run('npm run package');
let failed = 0;
for (const { t } of todo) {
  try {
    t.install();
    console.log(`[install-local] ${t.name}: terpasang ${id}@${pkg.version}`);
  } catch (e) {
    failed++;
    console.error(`[install-local] ERROR install ke ${t.name} gagal: ${e.message}\n${e.stack}`);
  }
}
console.log('[install-local] Selesai. Jalankan "Developer: Reload Window" di VS Code (WSL dan Windows).');
process.exit(failed ? 1 : 0);
