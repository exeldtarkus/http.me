// Profile VS Code untuk install-local: --profile <nama> | --profile=<nama> | env HTTPME_PROFILE (kosong = Default).
function parseProfile(argv, env) {
  const i = argv.findIndex((a) => a === '--profile' || a.startsWith('--profile='));
  const v = i < 0 ? undefined : argv[i].includes('=') ? argv[i].slice('--profile='.length) : argv[i + 1];
  return v || env.HTTPME_PROFILE || undefined;
}

const profileArgs = (profile) => (profile ? ['--profile', profile] : []);

module.exports = { parseProfile, profileArgs };
