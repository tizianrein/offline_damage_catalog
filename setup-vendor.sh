#!/bin/bash
# =============================================================
# setup-vendor.sh — downloads the Three.js + JSZip libraries
# into ./vendor/ so the app works fully offline without CDN.
#
# Run once after cloning the repo:
#   bash setup-vendor.sh
#
# Then commit the contents of ./vendor/ along with the rest.
# =============================================================
set -e

THREE_VERSION="0.161.0"
JSZIP_VERSION="3.10.1"

THREE_BASE="https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}"
JSZIP_BASE="https://cdn.jsdelivr.net/npm/jszip@${JSZIP_VERSION}"

mkdir -p vendor/three/build
mkdir -p vendor/three/examples/jsm/loaders
mkdir -p vendor/three/examples/jsm/controls
mkdir -p vendor/three/examples/jsm/utils
mkdir -p vendor/jszip

echo "==> Downloading Three.js core ${THREE_VERSION}"
curl -fsSL "${THREE_BASE}/build/three.module.js" \
  -o vendor/three/build/three.module.js

echo "==> Downloading GLTFLoader"
curl -fsSL "${THREE_BASE}/examples/jsm/loaders/GLTFLoader.js" \
  -o vendor/three/examples/jsm/loaders/GLTFLoader.js

echo "==> Downloading OrbitControls"
curl -fsSL "${THREE_BASE}/examples/jsm/controls/OrbitControls.js" \
  -o vendor/three/examples/jsm/controls/OrbitControls.js

echo "==> Downloading BufferGeometryUtils (used by GLTFLoader)"
curl -fsSL "${THREE_BASE}/examples/jsm/utils/BufferGeometryUtils.js" \
  -o vendor/three/examples/jsm/utils/BufferGeometryUtils.js

echo "==> Downloading JSZip ESM build ${JSZIP_VERSION}"
# The pure ESM build that exports a default — what `import JSZip from 'jszip'` expects.
curl -fsSL "${JSZIP_BASE}/+esm" \
  -o vendor/jszip/jszip.esm.js

echo
echo "Done. Listing what was fetched:"
find vendor -type f -name '*.js' -exec ls -lh {} \;
echo
echo "Now commit the 'vendor/' folder along with the app."
