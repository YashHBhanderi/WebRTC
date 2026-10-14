#!/usr/bin/env bash
# Installs whisper.cpp (native, no Python) and the most accurate model this server can run.
# Usage (Ubuntu): sudo bash scripts/install-whisper.sh [model]   (Windows: scripts\install-whisper.ps1)
#   model: optional, e.g. large-v3, large-v3-q5_0, large-v3-turbo, medium — default chosen from RAM.
# Then set in .env: WHISPER_CPP_BIN=/opt/whisper.cpp/build/bin/whisper-cli, WHISPER_MODEL_DIR=/opt/whisper.cpp/models
set -euo pipefail

DIR=/opt/whisper.cpp

apt-get update
apt-get install -y --no-install-recommends git cmake build-essential ffmpeg curl ca-certificates

if [ ! -d "$DIR/.git" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$DIR"
fi
cd "$DIR"
# Native CPU optimisations of this machine (AVX2 / AVX-512 / NEON); add -DGGML_CUDA=1 on a GPU instance
cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
cmake --build build -j "$(nproc)" --config Release --target whisper-cli

MODEL="${1:-}"
if [ -z "$MODEL" ]; then
  # The app lets whisper use 60% of RAM (WHISPER_MAX_MEMORY_MB); calls keep the rest
  RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  BUDGET=$((RAM_MB * 60 / 100))
  if   [ "$BUDGET" -ge 4700 ]; then MODEL=large-v3
  elif [ "$BUDGET" -ge 1900 ]; then MODEL=large-v3-q5_0
  elif [ "$BUDGET" -ge 1100 ]; then MODEL=large-v3-turbo-q5_0
  else MODEL=base
  fi
  echo "RAM ${RAM_MB} MB, whisper budget ${BUDGET} MB -> ${MODEL}"
fi
bash models/download-ggml-model.sh "$MODEL"

echo
echo "whisper.cpp: $DIR/build/bin/whisper-cli"
echo "model:       $DIR/models/ggml-$MODEL.bin"
echo "CPU cores:   $(nproc) (the app uses half by default; WHISPER_THREADS overrides)"
