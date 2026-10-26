#!/usr/bin/env bash
# Build and package locally; the target server only needs Node.js.
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if (( $# > 1 )); then
  echo "Usage: bash package.sh [output-directory]" >&2
  exit 1
fi

node --input-type=module -e '
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error("Node.js >= 22.12 is required");
  process.exit(1);
}
'

if [[ ! -f .env ]]; then
  echo "Missing .env: create the deployment configuration first (see DEPLOYE.md)" >&2
  exit 1
fi

npm ci --include=dev
npm test
npm run build

OUTPUT_DIR="${1:-$PROJECT_DIR/releases}"
mkdir -p -- "$OUTPUT_DIR"
OUTPUT_DIR="$(cd -- "$OUTPUT_DIR" && pwd)"
VERSION="$(node --input-type=module -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync("package.json", "utf8")).version)')"
if [[ ! "$VERSION" =~ ^[0-9A-Za-z._+-]+$ ]]; then
  echo "Invalid package version" >&2
  exit 1
fi
PACKAGE_NAME="kubescope-${VERSION}-$(date -u +%Y%m%dT%H%M%SZ)"
STAGING_DIR="$(mktemp -d)"
trap 'rm -rf -- "$STAGING_DIR"' EXIT
mkdir -p "$STAGING_DIR/kubescope/server"

cp -R dist deploy "$STAGING_DIR/kubescope/"
cp server/index.js server/kubernetes.js "$STAGING_DIR/kubescope/server/"
cp package.json package-lock.json DEPLOYE.md deploy.sh start.sh stop.sh "$STAGING_DIR/kubescope/"
# Bundle production dependencies so the server needs no npm install.
(cd "$STAGING_DIR/kubescope" && npm ci --omit=dev --ignore-scripts)
chmod -R u=rwX,go=rX "$STAGING_DIR/kubescope"
cp .env "$STAGING_DIR/kubescope/.env"
chmod 600 "$STAGING_DIR/kubescope/.env"
ARCHIVE="$OUTPUT_DIR/$PACKAGE_NAME.tar.gz"
if [[ -e "$ARCHIVE" ]]; then
  echo "Archive already exists: $ARCHIVE" >&2
  exit 1
fi
tar -czf "$ARCHIVE" -C "$STAGING_DIR" kubescope
echo "Package created: $ARCHIVE"
