// Profile VS Code untuk install-local: --profile <nama> | --profile=<nama> | env HTTPME_PROFILE (kosong = Default).
function parseProfile(argv, env) {
  const i = argv.findIndex((a) => a === '--profile' || a.startsWith('--profile='));
  const v = i < 0 ? undefined : argv[i].includes('=') ? argv[i].slice('--profile='.length) : argv[i + 1];
  return v || env.HTTPME_PROFILE || undefined;
}

const profileArgs = (profile) => (profile ? ['--profile', profile] : []);

module.exports = { parseProfile, profileArgs };

/** profile yang dipakai window VS Code untuk folder WSL ini, dari storage.json Windows (undefined = Default / tidak ketemu) */
function detectProfile(storage, distro, folder) {
  const want = `vscode-remote://wsl+${distro}${folder}`.toLowerCase();
  const assoc = storage?.profileAssociations?.workspaces ?? {};
  const key = Object.keys(assoc).find((k) => decodeURIComponent(k).toLowerCase() === want);
  return (storage?.userDataProfiles ?? []).find((p) => p.location === assoc[key])?.name;
}

module.exports.detectProfile = detectProfile;
