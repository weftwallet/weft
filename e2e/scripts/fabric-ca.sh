#!/usr/bin/env bash
# Downloads the Fabric CA server and client into e2e/.bin (once).
# The tests run a real Fabric CA; nothing else from Fabric is needed unless
# you run them against the playground with WEFT_E2E_STACK=playground.
set -euo pipefail

VERSION="${FABRIC_CA_VERSION:-1.5.17}"
here="$(cd "$(dirname "$0")/.." && pwd)"
bin="$here/.bin"

if [[ -x "$bin/fabric-ca-server" && -x "$bin/fabric-ca-client" ]]; then
  echo "Fabric CA already in $bin"
  exit 0
fi

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Unsupported architecture: $arch" >&2; exit 1 ;;
esac

url="https://github.com/hyperledger/fabric-ca/releases/download/v${VERSION}/hyperledger-fabric-ca-${os}-${arch}-${VERSION}.tar.gz"
tmp="$(mktemp -d)"
echo "Downloading Fabric CA ${VERSION} for ${os}-${arch}"
curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 "$url" -o "$tmp/ca.tgz"
tar -xzf "$tmp/ca.tgz" -C "$tmp"
mkdir -p "$bin"
cp "$tmp/bin/fabric-ca-server" "$tmp/bin/fabric-ca-client" "$bin/"
rm -rf "$tmp"
echo "Fabric CA ${VERSION} is in $bin"
