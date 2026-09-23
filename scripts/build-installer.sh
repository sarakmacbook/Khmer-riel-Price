#!/usr/bin/env bash
# Builds release files into public/ (served by the deployed site):
#   public/install.sh    → self-contained installer: install.sh + ALL project files embedded
#   public/wingrate.zip  → plain project download
#
# Usage:  bash scripts/build-installer.sh
# Then on any VPS:  curl -fsSL https://your-app.vercel.app/install.sh | sudo bash
set -euo pipefail
cd "$(dirname "$0")/.."

EXCLUDES=(--exclude=./node_modules --exclude=./.next --exclude=./.git --exclude=./.vercel
          --exclude=./.env --exclude='./.env.local' --exclude='./.env.*.local'
          --exclude='*.zip' --exclude=./public/install.sh --exclude=./next-env.d.ts
          --exclude='*.tsbuildinfo' --exclude=./dist --exclude=./.testmocks)

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/wingrate"
tar "${EXCLUDES[@]}" -cf - . | tar -xf - -C "$tmp/wingrate"

# 1) tar.gz payload → base64, embedded between the markers in install.sh
tar -czf "$tmp/payload.tgz" -C "$tmp" wingrate
{
  sed '/^# @@PAYLOAD_START@@$/,$d' install.sh
  echo '# @@PAYLOAD_START@@'
  echo "# Embedded: $(find "$tmp/wingrate" -type f | wc -l | tr -d ' ') files, built $(date -u +%Y-%m-%dT%H:%MZ)"
  echo 'HAS_PAYLOAD=1'
  echo 'payload() {'
  echo "base64 -d <<'__WINGRATE_PAYLOAD__'"
  base64 -w 76 "$tmp/payload.tgz"
  echo '__WINGRATE_PAYLOAD__'
  echo '}'
  sed -n '/^# @@PAYLOAD_END@@$/,$p' install.sh
} > public/install.sh
chmod +x public/install.sh
bash -n public/install.sh

# 2) zip download
rm -f public/wingrate.zip
(cd "$tmp" && zip -qr wingrate.zip wingrate && mv wingrate.zip "$OLDPWD/public/wingrate.zip")

echo "✔ public/install.sh   $(du -h public/install.sh | cut -f1)  (self-contained, $(find "$tmp/wingrate" -type f | wc -l | tr -d ' ') files embedded)"
echo "✔ public/wingrate.zip $(du -h public/wingrate.zip | cut -f1)"
