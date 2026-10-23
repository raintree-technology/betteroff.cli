#!/bin/sh
# Installs the BetterOff CLI from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/raintree-technology/betteroff.cli/main/install.sh | sh
#
# BETTEROFF_VERSION     a version such as 0.1.0 (default: the latest release)
# BETTEROFF_INSTALL_DIR where to put the binary (default: ~/.local/bin)
#
# The binary must match the release's SHA256SUMS. When the GitHub CLI is installed and signed in,
# its build provenance is checked too, which proves it was built by this repository's release
# workflow. A failed check stops the install.
set -eu

REPO="raintree-technology/betteroff.cli"
INSTALL_DIR="${BETTEROFF_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
	printf 'betteroff install: %s\n' "$1" >&2
	exit 1
}

case "$(uname -s)" in
Darwin) os="darwin" ;;
Linux) os="linux" ;;
*) fail "this script supports macOS and Linux. On Windows, download betteroff-windows-x64.exe from https://github.com/$REPO/releases" ;;
esac

case "$(uname -m)" in
arm64 | aarch64) arch="arm64" ;;
x86_64 | amd64) arch="x64" ;;
*) fail "unsupported processor: $(uname -m)" ;;
esac

# An Intel shell on Apple silicon (Rosetta) still gets the native build.
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
	arch="arm64"
fi

asset="betteroff-$os-$arch"

if [ -n "${BETTEROFF_VERSION:-}" ]; then
	case "$BETTEROFF_VERSION" in
	*[!0-9.]* | "") fail "BETTEROFF_VERSION must look like 0.1.0" ;;
	esac
	base="https://github.com/$REPO/releases/download/v$BETTEROFF_VERSION"
else
	base="https://github.com/$REPO/releases/latest/download"
fi

command -v curl >/dev/null 2>&1 || fail "curl is required"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

download() {
	curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$tmp/$1" "$base/$1" || fail "could not download $base/$1"
}

printf 'Downloading %s...\n' "$asset"
download "$asset"
download SHA256SUMS

expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || fail "$asset is not listed in SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then
	actual="$(sha256sum "$tmp/$asset" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
	actual="$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')"
else
	fail "sha256sum or shasum is required to check the download"
fi

[ "$actual" = "$expected" ] || fail "checksum mismatch for $asset (expected $expected, got $actual)"
printf 'Checksum OK.\n'

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
	gh attestation verify "$tmp/$asset" --repo "$REPO" >/dev/null 2>&1 ||
		fail "build provenance check failed for $asset. Do not use this file."
	printf 'Build provenance OK: built by %s.\n' "$REPO"
else
	printf 'Skipped the build provenance check (needs the GitHub CLI, signed in). To check later:\n'
	printf '  gh attestation verify %s/betteroff --repo %s\n' "$INSTALL_DIR" "$REPO"
fi

mkdir -p "$INSTALL_DIR"
chmod 0755 "$tmp/$asset"
mv "$tmp/$asset" "$INSTALL_DIR/betteroff"

printf 'Installed %s\n' "$("$INSTALL_DIR/betteroff" --version | sed 's/^/betteroff /')"
printf 'Location: %s/betteroff\n' "$INSTALL_DIR"

case ":$PATH:" in
*":$INSTALL_DIR:"*) printf 'Next: betteroff login\n' ;;
*) printf 'Add %s to your PATH, then run: betteroff login\n' "$INSTALL_DIR" ;;
esac
