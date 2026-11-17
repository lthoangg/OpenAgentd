#!/usr/bin/env bash
# Compiles the Keychain write order, the Show Previews rule and the
# foreground push rule for macOS and checks them. macOS only.
set -euo pipefail
cd "$(dirname "$0")"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
swiftc -parse-as-library -O ../App/KeychainWrite.swift ../App/ForegroundPush.swift ../NotificationService/PreviewPolicy.swift SwiftChecks.swift -o "$out/swift-checks"
"$out/swift-checks"
