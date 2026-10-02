#!/usr/bin/env bash
#
# Enable engram's optional semantic search (README "Semantic search (optional)", DECISIONS D42-D44)
# on an existing engram install, in one run:
#
#   1. find the registered engram install (the one Claude Code's hooks point at)
#   2. download the three all-MiniLM-L6-v2 model files (or copy them with --from) and check each
#      file's sha256 against the values this project was evaluated with
#   3. write the "embedding" block into <data dir>/config.json (other keys are kept; a backup is made)
#   4. `engram model verify`, then `engram embed` to embed every existing memory
#
# Safe to run again: files that already match are not downloaded twice, and `engram embed` only
# embeds what is missing. If the model does not verify, config.json is put back as it was.
#
# This is the ONLY place engram touches the network, and only because you ran it; engram itself never
# downloads anything at runtime.
#
# usage:
#   enable-semantic-search.sh              enable (download the model if needed)
#   enable-semantic-search.sh --from DIR   enable, copying the model files from DIR (no network)
#   enable-semantic-search.sh --off        turn semantic search off again (keeps the model files)
#
# environment (all optional):
#   ENGRAM_ROOT             engram install root (the directory containing dist/cli.js)
#   ENGRAM_NODE             node binary to run engram with
#   ENGRAM_DB               same meaning as for engram itself: absolute path of the database
#   CLAUDE_CONFIG_DIR       Claude Code config dir (default ~/.claude), used to find the install
#   ENGRAM_MODEL_BASE_URL   where to download from (default: the Xenova/all-MiniLM-L6-v2 repository
#                           on huggingface.co) -- point it at an internal mirror if needed

set -euo pipefail
umask 077

MODEL_NAME='all-MiniLM-L6-v2'
BASE_URL="${ENGRAM_MODEL_BASE_URL:-https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main}"

# "<file name on disk> <path under BASE_URL> <sha256>" -- the model hash is the one D43/D44 measured;
# a different file is a different model, so a mismatch is a hard stop, never a warning.
FILES=(
  'model_quantized.onnx onnx/model_quantized.onnx afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1'
  'tokenizer.json tokenizer.json da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0'
  'tokenizer_config.json tokenizer_config.json 9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3'
)
MODEL_SHA256='afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1'

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() { sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; }

MODE='on'
FROM_DIR=''
while [ $# -gt 0 ]; do
  case "$1" in
    --from) [ $# -ge 2 ] || die '--from needs a directory'; FROM_DIR="$2"; shift 2 ;;
    --off) MODE='off'; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument '$1'" ;;
  esac
done

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else die 'neither shasum nor sha256sum is available'
  fi
}

# --- 1. find the engram install -----------------------------------------------------------------
# `engram install` registers hooks as:  ENGRAM_HOOK=1 "<node>" "<root>/dist/cli.js" <cmd> || true
# so the registered node binary and install root can be read back from Claude Code's settings.json.
NODE_BIN="${ENGRAM_NODE:-}"
ROOT="${ENGRAM_ROOT:-}"
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"

if [ -z "$ROOT" ] && [ -f "$SETTINGS" ]; then
  hook=$(grep -o 'ENGRAM_HOOK=1 \\"[^"]*\\" \\"[^"]*cli\.js\\"' "$SETTINGS" | head -n 1 || true)
  if [ -n "$hook" ]; then
    hook=$(printf '%s' "$hook" | sed -e 's#\\/#/#g' -e 's#\\"#"#g')
    [ -n "$NODE_BIN" ] || NODE_BIN=$(printf '%s' "$hook" | cut -d'"' -f2)
    cli=$(printf '%s' "$hook" | cut -d'"' -f4)
    ROOT="${cli%/dist/cli.js}"
  fi
fi
if [ -z "$ROOT" ]; then
  # Not registered with Claude Code (or settings unreadable): fall back to the checkout this script is in.
  here=$(cd "$(dirname "$0")/.." && pwd)
  [ -f "$here/dist/cli.js" ] && ROOT="$here"
fi
[ -n "$ROOT" ] || die "could not find an engram install. Install engram first (README \"Installing for real\"), or set ENGRAM_ROOT to the directory that contains dist/cli.js."
[ -n "$NODE_BIN" ] || NODE_BIN=$(command -v node || true)
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || die 'could not find node. Set ENGRAM_NODE to the node binary engram runs with.'

CLI="$ROOT/dist/cli.js"
[ -f "$CLI" ] || die "$CLI does not exist -- build the install first (npm ci && npm run build in $ROOT)."
[ -f "$ROOT/dist/cli/commands/embed.js" ] || die "the engram install at $ROOT is older than Phase 6 and has no semantic search. Upgrade it first (README \"Upgrading a live install\")."

if [ -n "${ENGRAM_DB:-}" ]; then
  case "$ENGRAM_DB" in /*) ;; *) die "ENGRAM_DB must be an absolute path (got: $ENGRAM_DB)" ;; esac
  DATA_DIR=$(dirname "$ENGRAM_DB")
  DB_FILE="$ENGRAM_DB"
else
  DATA_DIR="$HOME/.engram"
  DB_FILE="$DATA_DIR/engram.db"
fi
[ -f "$DB_FILE" ] || die "no engram database at $DB_FILE -- start one Claude Code session with engram installed first."

CONFIG="$DATA_DIR/config.json"
MODEL_DIR="$DATA_DIR/models/$MODEL_NAME"

say "engram install: $ROOT"
say "node:           $NODE_BIN"
say "data dir:       $DATA_DIR"

# --- config helpers -------------------------------------------------------------------------------
BACKUP=''
backup_config() {
  if [ -f "$CONFIG" ]; then
    BACKUP="$CONFIG.backup-$(date +%Y%m%d%H%M%S)"
    cp -p "$CONFIG" "$BACKUP"
  fi
}
restore_config() {
  if [ -n "$BACKUP" ]; then cp -p "$BACKUP" "$CONFIG"; else rm -f "$CONFIG"; fi
}
# Merges {embedding: {...}} into config.json, keeping every other key; refuses to touch a file that
# is not a JSON object rather than overwrite something it does not understand.
write_config() { # $1 = enabled (true|false)
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const [file, enabled, modelDir, sha256] = process.argv.slice(1);
    let cfg = {};
    if (fs.existsSync(file)) {
      cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("not a JSON object");
    }
    const prev = cfg.embedding && typeof cfg.embedding === "object" ? cfg.embedding : {};
    cfg.embedding = enabled === "true" ? { ...prev, enabled: true, modelDir, sha256 } : { ...prev, enabled: false };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  ' "$CONFIG" "$1" "$MODEL_DIR" "$MODEL_SHA256" || die "$CONFIG exists but could not be updated (is it valid JSON?). Nothing was changed."
  chmod 600 "$CONFIG"
}

# --- --off ----------------------------------------------------------------------------------------
if [ "$MODE" = 'off' ]; then
  backup_config
  write_config false
  say ''
  say 'Semantic search is OFF. Start a new Claude Code session for it to take effect;'
  say 'search is back to keyword-only. The model files and stored vectors are kept.'
  exit 0
fi

# --- 2. model files -------------------------------------------------------------------------------
mkdir -p "$MODEL_DIR"
for entry in "${FILES[@]}"; do
  # shellcheck disable=SC2086
  set -- $entry
  name="$1"; remote="$2"; want="$3"
  dest="$MODEL_DIR/$name"
  if [ -f "$dest" ] && [ "$(sha256_of "$dest")" = "$want" ]; then
    say "ok (already present): $name"
    continue
  fi
  tmp="$dest.download"
  rm -f "$tmp"
  if [ -n "$FROM_DIR" ]; then
    [ -f "$FROM_DIR/$name" ] || die "$FROM_DIR/$name not found (--from needs model_quantized.onnx, tokenizer.json and tokenizer_config.json)"
    cp "$FROM_DIR/$name" "$tmp"
  else
    command -v curl >/dev/null 2>&1 || die 'curl is not available -- download the files yourself and use --from DIR'
    say "downloading $name ..."
    curl -fL --retry 2 --connect-timeout 20 -o "$tmp" "$BASE_URL/$remote" \
      || { rm -f "$tmp"; die "download of $name failed. If this machine cannot reach $BASE_URL, copy the three files here by other means and re-run with --from DIR."; }
  fi
  got=$(sha256_of "$tmp")
  if [ "$got" != "$want" ]; then
    rm -f "$tmp"
    die "sha256 mismatch for $name (expected $want, got $got). This is not the file engram was evaluated with; nothing was enabled."
  fi
  mv "$tmp" "$dest"
  say "ok: $name"
done

# --- 3. config ------------------------------------------------------------------------------------
backup_config
write_config true

# --- 4. verify, then embed existing memories ----------------------------------------------------------
say ''
say 'verifying the model ...'
if ! "$NODE_BIN" "$CLI" model verify; then
  restore_config
  die "the model did not verify (reason above), so config.json was put back as it was. If the reason mentions onnxruntime-node or tokenizers, the install was built without optional dependencies: run 'npm ci && npm run build' in $ROOT and try again."
fi

say ''
say 'embedding existing memories (a few ms each; safe to interrupt and re-run) ...'
if ! "$NODE_BIN" "$CLI" embed; then
  say ''
  say "warning: 'engram embed' did not finish (reason above; e.g. engram is paused, or the database was busy)."
  say "Semantic search is enabled; run this to finish embedding:  \"$NODE_BIN\" \"$CLI\" embed"
  exit 1
fi

say ''
say 'Semantic search is ON.'
say 'Start a new Claude Code session for it to take effect (running sessions keep keyword-only search).'
[ -z "$BACKUP" ] || say "Previous config saved as $BACKUP"
say "To turn it off again:  $0 --off"
