#!/usr/bin/env bash
# Rilis lewat GitHub Actions (.github/workflows/release.yml): pilih versi -> package.json -> commit + push -> tag vX.Y.Z -> push tag.
# Workflow yang publish ke Open VSX + VS Code Marketplace (trusted publishing) dan membuat GitHub Release; script ini menunggu dan menampilkan hasilnya.
# run: npm run deploy
#      bash scripts/deploy-v2.sh --self-test
#      bash scripts/deploy-v2.sh --channel 0.2.0   -> pre-release / stable (dipakai release.yml)
set -euo pipefail

# versi berikutnya: next_version 1.1.0 patch -> 1.1.1, minor -> 1.2.0, major -> 2.0.0
next_version() {
  local major minor patch
  [[ "$1" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "version '$1' is not X.Y.Z" >&2; return 1; }
  major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]}
  case "$2" in
    patch) echo "$major.$minor.$((patch + 1))" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    major) echo "$((major + 1)).0.0" ;;
    *) echo "unknown bump '$2'" >&2; return 1 ;;
  esac
}

# kanal rilis: < 1.0.0 = pre-release; setelah 1.0 minor ganjil = pre-release, minor genap = stable; suffix (-beta) ditolak
channel() {
  [[ "$1" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || { echo "version '$1' is not X.Y.Z (no -beta suffix; use pre-release channel)" >&2; return 1; }
  if (( BASH_REMATCH[1] < 1 || BASH_REMATCH[2] % 2 == 1 )); then echo pre-release; else echo stable; fi
}

if [[ "${1:-}" == --channel ]]; then
  channel "${2:-}"
  exit
fi

if [[ "${1:-}" == --self-test ]]; then
  check() { [[ "$1" == "$2" ]] && echo "ok   $3" || { echo "FAIL $3: got '$1', want '$2'"; exit 1; }; }
  check "$(next_version 1.1.0 patch)" 1.1.1 patch
  check "$(next_version 1.1.0 minor)" 1.2.0 minor
  check "$(next_version 1.1.0 major)" 2.0.0 major
  check "$(next_version 0.6.9 patch)" 0.6.10 "patch past 9"
  check "$(next_version 1.9.3 minor)" 1.10.0 "minor resets patch"
  check "$(next_version 3.4.5 major)" 4.0.0 "major resets minor and patch"
  check "$(next_version 1.2 patch 2>/dev/null || echo error)" error "not X.Y.Z"
  check "$(next_version 1.2.3-beta patch 2>/dev/null || echo error)" error "pre-release refused"
  check "$(next_version 1.2.3 huge 2>/dev/null || echo error)" error "unknown bump"
  check "$(channel 0.0.1)" pre-release "0.x pre-release"
  check "$(channel 0.2.0)" pre-release "0.x even minor still pre-release"
  check "$(channel 1.0.0)" stable "1.0 stable"
  check "$(channel 1.1.0)" pre-release "odd minor pre-release"
  check "$(channel 1.2.5)" stable "even minor stable"
  check "$(channel 2.3.1)" pre-release "odd minor pre-release after 2.0"
  check "$(channel 1.0.0-beta 2>/dev/null || echo error)" error "suffix refused"
  check "$(channel 1.0 2>/dev/null || echo error)" error "channel not X.Y.Z"
  exit 0
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
say() { echo "[deploy] $*"; }
die() { echo "[deploy] $*" >&2; exit 1; }
confirm() { local a; read -r -p "[deploy] $1 [y/N] " a; [[ "$a" =~ ^[yY] ]]; }

[[ -t 0 ]] || die "Interactive terminal required (version choice and confirmation)."
branch=$(git branch --show-current)
[[ "$branch" == main ]] || die "Release from main only (now on '$branch')."
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "Uncommitted changes in tracked files; commit or stash them first."
git fetch -q origin main --tags
[[ "$(git rev-list --count HEAD..origin/main)" == 0 ]] || die "Local main is behind origin/main; run git pull first."

current=$(node -p "require('./package.json').version")
name=$(node -p "require('./package.json').name")
publisher=$(node -p "require('./package.json').publisher")
channel "$current" >/dev/null || die "package.json version $current is invalid."
remote=$(git remote get-url origin)
[[ "$remote" =~ github\.com[:/]([^/]+)/([^/]+)$ ]] || die "origin is not a GitHub repository: $remote"
repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}" # nama repo boleh mengandung titik (http.me)
released() { git ls-remote --exit-code --tags origin "refs/tags/v$1" >/dev/null 2>&1; }

echo
say "$publisher.$name, current version $current$(released "$current" && echo ' (already released)')"
echo "  1) use current version  $current ($(channel "$current"))"
v=$(next_version "$current" patch); echo "  2) patch                $v ($(channel "$v"))"
v=$(next_version "$current" minor); echo "  3) minor                $v ($(channel "$v"))"
v=$(next_version "$current" major); echo "  4) major                $v ($(channel "$v"))"
read -r -p "[deploy] Choose 1-4: " choice
case "$choice" in
  1) version=$current bump= ;;
  2) bump=patch ;;
  3) bump=minor ;;
  4) bump=major ;;
  *) die "Cancelled (no choice)." ;;
esac
[[ -n "$bump" ]] && version=$(next_version "$current" "$bump")
kind=$(channel "$version")
tag="v$version"
released "$version" && die "$tag already exists on GitHub; choose a new version."
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "Tag $tag exists locally but not on GitHub; delete it (git tag -d $tag) or push it yourself."

read -r -p "[deploy] Release summary for the tag (optional): " summary
# pasang juga di VS Code lokal (scripts/install-local.js: di WSL = VS Code Server WSL + profile Windows)
where_local="your local VS Code"
[[ -n "${WSL_DISTRO_NAME:-}" ]] && where_local="VS Code in WSL and your Windows profile"
install_local=
confirm "Install $version in $where_local too?" && install_local=1
echo
say "Plan:"
[[ -n "$bump" ]] && say "  - package.json / package-lock.json $current -> $version, commit \"$version\", push main"
say "  - unit tests (npm test)"
say "  - tag $tag${summary:+ \"$tag: $summary\"}, push tag -> GitHub Actions publishes as $kind to Open VSX + VS Code Marketplace and creates the GitHub Release"
[[ -n "$install_local" ]] && say "  - install $version in $where_local (npm run install:local)"
confirm "Continue?" || die "Cancelled, nothing changed."

say "Running unit tests…"
npm test --silent >/dev/null 2>&1 || die "Unit tests failed (run npm test); nothing changed."

if [[ -n "$bump" ]]; then
  npm version "$version" --no-git-tag-version >/dev/null
  git add package.json package-lock.json
  git commit -q -m "$version"
  git push -q origin main
  say "Pushed $version to main."
fi
git tag -a "$tag" -m "$tag${summary:+: $summary}"
git push -q origin "$tag"
say "Pushed $tag, workflow Release started: https://github.com/$repo/actions/workflows/release.yml"
if [[ -n "$install_local" ]]; then
  say "Installing $version in $where_local…"
  node scripts/install-local.js || say "Local install failed (see above); the release itself keeps running on GitHub."
fi

# hasil workflow (API publik GitHub, tanpa token); Ctrl+C = berhenti menunggu, rilis tetap berjalan di GitHub
say "Waiting for the workflow (Ctrl+C stops waiting, the release keeps running)…"
api="https://api.github.com/repos/$repo/actions/runs?event=push&branch=$tag&per_page=1"
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=(JSON.parse(s).workflow_runs||[])[0]||{};console.log(r[process.argv[1]]??"")})' "$1"; }
last=
for _ in $(seq 1 120); do
  sleep 10
  json=$(curl -fsS "$api" 2>/dev/null) || continue
  status=$(field status <<<"$json")
  [[ -n "$status" && "$status" != "$last" ]] && say "  status: $status" && last=$status
  if [[ "$status" == completed ]]; then
    conclusion=$(field conclusion <<<"$json")
    say "  result: $conclusion ($(field html_url <<<"$json"))"
    if [[ "$conclusion" == success ]]; then
      say "Open VSX: https://open-vsx.org/extension/$publisher/$name/$version"
      say "Release:  https://github.com/$repo/releases/tag/$tag"
      say "VS Code Marketplace: https://marketplace.visualstudio.com/items?itemName=$publisher.$name (appears after Marketplace verification, a few minutes)"
      say "  if the step \"Publish to VS Code Marketplace\" in the run is red, upload $name-$version.vsix from the Release at https://marketplace.visualstudio.com/manage"
      exit 0
    fi
    die "Workflow failed; open the run above for the log."
  fi
done
say "Still running after 20 minutes; check https://github.com/$repo/actions"
