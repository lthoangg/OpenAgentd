#!/usr/bin/env bash
# Compiles the Notification Service Extension's letter opener for macOS and
# runs it against the contract's letter vectors. macOS only (CryptoKit).
set -euo pipefail
cd "$(dirname "$0")"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
swiftc -parse-as-library -O ../NotificationService/LetterOpener.swift LetterVectors.swift -o "$out/letter-vectors"
"$out/letter-vectors" ../../../appv3/contract/tunnel_vectors.json
