// Publish extension ke Open VSX (https://open-vsx.org), lalu buat tag vX.Y.Z + GitHub Release (lampiran .vsix).
// run: npm run deploy:token           (token diminta sekali, lalu disimpan di deployment/vsx/token)
//      npm run deploy:token -- --new-token  (masukkan ulang token, mis. jika expired)
const { execSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const tokenDir = path.join(root, 'deployment', 'vsx');
const tokenFile = path.join(tokenDir, 'token');
const registry = 'https://open-vsx.org';
const vsix = `${pkg.name}-${pkg.version}.vsix`;

const log = (msg) => console.log(`[deploy] ${msg}`);

function fail(msg) {
  console.error(`[deploy] ${msg}`);
  process.exit(1);
}

/** Token dikirim lewat env OVSX_PAT agar tidak terlihat di daftar proses. */
function run(cmd, token) {
  execSync(cmd, { cwd: root, stdio: 'inherit', env: token ? { ...process.env, OVSX_PAT: token } : process.env });
}

/** Status HTTP dari GET ke API Open VSX (200 = ada, 404 = belum ada). */
function apiStatus(urlPath) {
  return new Promise((resolve, reject) => {
    https.get(`${registry}/api/${urlPath}`, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

/** Baca input tanpa menampilkan karakter yang diketik. */
function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(input.trim());
          return;
        }
        if (ch === '\u0003') {
          stdout.write('\n');
          process.exit(130); // Ctrl+C
        }
        input = ch === '\u007f' || ch === '\b' ? input.slice(0, -1) : input + ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function getToken() {
  if (!process.argv.includes('--new-token') && fs.existsSync(tokenFile)) {
    const saved = fs.readFileSync(tokenFile, 'utf8').trim();
    if (saved) {
      log(`Memakai token dari ${path.relative(root, tokenFile)}`);
      return saved;
    }
  }
  if (!process.stdin.isTTY) {
    fail(`Token belum ada di ${path.relative(root, tokenFile)} dan terminal tidak interaktif.`);
  }
  const token = await askHidden('Open VSX access token (open-vsx.org → Settings → Access Tokens): ');
  if (!token) {
    fail('Token kosong, dibatalkan.');
  }
  fs.mkdirSync(tokenDir, { recursive: true });
  fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  log(`Token disimpan di ${path.relative(root, tokenFile)}`);
  return token;
}

const git = (cmd) => execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();

/** Tag harus menunjuk commit yang sama dengan isi .vsix, jadi worktree wajib bersih & sudah di-push. */
function checkGitReady() {
  if (git('status --porcelain --untracked-files=no')) {
    fail('Ada perubahan yang belum di-commit. Commit & push dulu sebelum deploy.');
  }
  git('fetch -q origin');
  const branch = git('branch --show-current');
  if (git('rev-parse HEAD') !== git(`rev-parse origin/${branch}`)) {
    fail(`HEAD belum sama dengan origin/${branch}. Push dulu sebelum deploy.`);
  }
}

/** owner/repo dari field repository di package.json. */
function githubRepo() {
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const m = /github\.com[:/](.+?)(\.git)?$/.exec(url || '');
  if (!m) {
    throw new Error('Field repository di package.json bukan repo GitHub.');
  }
  return m[1];
}

/** Token GitHub dari GITHUB_TOKEN atau git credential helper (tidak pernah dicetak). */
function githubToken() {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  const out = execSync('git credential fill', { cwd: root, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const token = /^password=(.*)$/m.exec(out)?.[1];
  if (!token) {
    throw new Error('Token GitHub tidak ditemukan (set GITHUB_TOKEN atau simpan di git credential).');
  }
  return token;
}

async function githubApi(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...options.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} ${url}: ${body.message || ''} ${JSON.stringify(body.errors || '')}`);
  }
  return body;
}

function releaseNotes(tag, namespace) {
  let prev = '';
  try {
    prev = git(`describe --tags --abbrev=0 ${tag}^`);
  } catch (err) {
    // Rilis pertama: belum ada tag sebelumnya, catatan berisi semua commit.
    console.error(`[deploy] releaseNotes - tag sebelumnya tidak ada: ${err.message}`);
  }
  const changes = git(`log --format=%s ${prev ? `${prev}..` : ''}${tag}`).split('\n').map((s) => `- ${s}`).join('\n');
  return [
    `## Changes${prev ? ` since ${prev}` : ''}`,
    changes,
    '',
    `- VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=${namespace}.${pkg.name}`,
    `- Open VSX: ${registry}/extension/${namespace}/${pkg.name}`,
    '',
    '```',
    `ext install ${namespace}.${pkg.name}`,
    '```',
  ].join('\n');
}

/** Buat tag vX.Y.Z (bila belum ada), push, lalu GitHub Release + lampiran .vsix. */
async function createGithubRelease(namespace) {
  const tag = `v${pkg.version}`;
  const repo = githubRepo();
  if (!git(`tag -l ${tag}`)) {
    git(`tag -a ${tag} -m "${tag}"`);
  }
  git(`push -q origin ${tag}`);
  log(`Tag ${tag} di-push.`);

  const token = githubToken();
  const release = await githubApi(`https://api.github.com/repos/${repo}/releases`, token, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, name: tag, body: releaseNotes(tag, namespace) }),
  });
  await githubApi(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${vsix}`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: fs.readFileSync(path.join(root, vsix)),
  });
  log(`GitHub Release: ${release.html_url}`);
}

async function main() {
  const namespace = pkg.publisher;
  const id = `${namespace}.${pkg.name}@${pkg.version}`;

  if ((await apiStatus(`${namespace}/${pkg.name}/${pkg.version}`)) === 200) {
    log(`${id} sudah ada di Open VSX. Tidak melakukan apa-apa.`);
    log('Naikkan version di package.json (npm version patch) untuk rilis baru.');
    return;
  }

  checkGitReady();
  const token = await getToken();

  if ((await apiStatus(namespace)) === 404) {
    log(`Namespace '${namespace}' belum ada, membuat...`);
    run(`npx ovsx create-namespace ${namespace}`, token);
  }
  log(`Memeriksa token untuk namespace '${namespace}'...`);
  try {
    run(`npx ovsx verify-pat ${namespace}`, token);
  } catch (err) {
    fail(`Token tidak valid untuk namespace ini (${err.message}). Jalankan ulang dengan: npm run deploy -- --new-token`);
  }

  run('npm test');
  run('npm run package');
  log(`Publish ${vsix}...`);
  run(`npx ovsx publish ${vsix}`, token);
  log(`Selesai: ${registry}/extension/${namespace}/${pkg.name}`);

  try {
    await createGithubRelease(namespace);
  } catch (err) {
    // Publish sudah sukses; release bisa dibuat ulang manual, jadi jangan gagalkan deploy.
    console.error(`[deploy] createGithubRelease - gagal membuat tag/release: ${err.message}\n${err.stack}`);
  }
}

main().catch((err) => fail(err.message));
