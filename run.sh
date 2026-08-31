#!/usr/bin/env bash
# 一鍵啟動:自動建立/啟用虛擬環境、安裝套件、執行 agent.py
set -e

cd "$(dirname "$0")"

if [ ! -d "venv" ]; then
    echo "首次執行,建立虛擬環境..."
    python3 -m venv venv
fi

source venv/bin/activate
pip install -q -r requirements.txt

if [ -z "$ANTHROPIC_API_KEY" ] && [ -f ".env" ]; then
    export "$(grep -v '^#' .env | xargs)"
fi

if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo "請先設定 ANTHROPIC_API_KEY(可以寫進 .env,或用 export ANTHROPIC_API_KEY=你的key)"
    exit 1
fi

python agent.py
