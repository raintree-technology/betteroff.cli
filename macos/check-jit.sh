#!/bin/sh
# Fails unless each signed macOS binary can JIT under the hardened runtime, which shows
# entitlements.plist grants what JavaScriptCore needs. Without allow-jit the binary still runs,
# about 70 times slower, so a plain --version check would not catch it.
# With the JIT off, numberOfDFGCompiles reports 1000000 instead of a real count.
set -eu
probe='const { numberOfDFGCompiles } = require("bun:jsc");
function f(n) { let s = 0; for (let i = 0; i < n; i++) s += i % 7; return s; }
for (let i = 0; i < 2000; i++) f(1e4);
const n = numberOfDFGCompiles(f);
console.log(process.arch, "DFG compiles:", n);
process.exit(n >= 1 && n < 1000000 ? 0 : 1);'
for file in "$@"; do
  case "$file" in
    *x64) BUN_BE_BUN=1 arch -x86_64 "$file" -e "$probe" ;;
    *) BUN_BE_BUN=1 "$file" -e "$probe" ;;
  esac || { echo "$file: JIT is off; check macos/entitlements.plist"; exit 1; }
done
