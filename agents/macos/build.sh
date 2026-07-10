#!/bin/sh
# Builds the macOS name agent into agents/dist (requires Xcode command-line tools)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/../dist"
swiftc -O -o "$DIR/../dist/YourCallAgent" "$DIR/main.swift" \
  -framework ApplicationServices -framework AppKit
echo "built agents/dist/YourCallAgent"
