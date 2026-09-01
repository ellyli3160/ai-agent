# AI Agent 練習專案:網頁搜尋助手

用 Python + Claude API 寫的最小可用 agent,示範一個完整的「工具呼叫循環」:

1. 使用者輸入問題
2. 模型判斷要不要呼叫工具(網頁搜尋 / 計算機)
3. 執行工具、把結果丟回給模型
4. 重複直到模型給出最終文字回覆

## 工具

- **`web_search`**:Claude API 內建的伺服器端工具,不用自己寫程式碼實作,模型會自動發出搜尋、讀取結果。
- **`calculator`**:自訂工具,示範「模型呼叫 → 本地執行 → 回傳結果」這個最基本的模式。

## 快速開始(推薦)

不用自己管虛擬環境,`run.sh` 會自動處理:

```bash
cp .env.example .env   # 填入你的 ANTHROPIC_API_KEY
./run.sh
```

之後每次要跑,只要 `./run.sh` 就好——它會自動建立/啟用虛擬環境、確保套件是最新的,再啟動 agent。

輸入 `exit` 離開。

## 手動設定(如果想自己掌控每一步)

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=你的key
python agent.py
```

## 之後可以練習擴充的方向

- 加一個自訂工具(例如讀寫本地檔案、查天氣 API),熟悉 `tool_use` → `tool_result` 的資料格式
- 把 `run_turn` 換成 SDK 的 `client.beta.messages.tool_runner`,比較手寫迴圈跟框架的差異
- 加上 `thinking={"type": "adaptive", "display": "summarized"}`,觀察模型的推理過程
- 限制 `web_search` 的 `allowed_domains`,或加上使用者確認機制再執行工具

## 注意

`agent.py` 預設用 `claude-sonnet-5`($2/$10 per 1M tokens)。如果想要更強的推理能力,可以把檔案裡的 `MODEL` 改成 `claude-opus-5`;想更省錢則可以改成 `claude-haiku-4-5`。
