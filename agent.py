import ast
import operator
import os
import sys

import anthropic

MODEL = "claude-opus-5"

WEB_SEARCH_TOOL = {
    "type": "web_search_20260209",
    "name": "web_search",
    "max_uses": 5,
}

CALCULATOR_TOOL = {
    "name": "calculator",
    "description": "Evaluate a basic arithmetic expression, e.g. '12 * (3 + 4)'.",
    "input_schema": {
        "type": "object",
        "properties": {
            "expression": {
                "type": "string",
                "description": "The arithmetic expression to evaluate.",
            }
        },
        "required": ["expression"],
    },
}

TOOLS = [WEB_SEARCH_TOOL, CALCULATOR_TOOL]

_CALC_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
}


def _eval_node(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _CALC_OPS:
        return _CALC_OPS[type(node.op)](_eval_node(node.left), _eval_node(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _CALC_OPS:
        return _CALC_OPS[type(node.op)](_eval_node(node.operand))
    raise ValueError(f"不支援的運算式: {ast.dump(node)}")


def run_calculator(expression: str) -> str:
    tree = ast.parse(expression, mode="eval")
    return str(_eval_node(tree.body))


def execute_tool(name: str, tool_input: dict) -> str:
    if name == "calculator":
        try:
            return run_calculator(tool_input["expression"])
        except Exception as e:
            return f"計算錯誤: {e}"
    raise ValueError(f"未知工具: {name}")


def print_search_results(block):
    content = block.content
    if isinstance(content, list):
        for r in content:
            print(f"    - {r.title}: {r.url}")
    else:
        print(f"    (搜尋失敗: {getattr(content, 'error_code', content)})")


def run_turn(client: anthropic.Anthropic, messages: list) -> list:
    """跑完一輪對話:模型可能連續呼叫多次工具,直到它給出最終文字回覆為止。"""
    while True:
        response = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            tools=TOOLS,
            messages=messages,
        )

        messages.append({"role": "assistant", "content": response.content})

        for block in response.content:
            if block.type == "text":
                print(f"\nAgent: {block.text}")
            elif block.type == "server_tool_use" and block.name == "web_search":
                print(f"  [搜尋] {block.input.get('query')}")
            elif block.type == "web_search_tool_result":
                print_search_results(block)
            elif block.type == "tool_use":
                print(f"  [呼叫工具] {block.name}({block.input})")

        if response.stop_reason == "pause_turn":
            # 伺服器端工具(例如網頁搜尋)的這一輪還沒結束,直接用同樣的
            # messages 再呼叫一次 API 以繼續這一輪。
            continue

        tool_use_blocks = [b for b in response.content if b.type == "tool_use"]
        if not tool_use_blocks:
            break

        tool_results = []
        for tool in tool_use_blocks:
            result = execute_tool(tool.name, tool.input)
            print(f"  [工具結果] {result}")
            tool_results.append(
                {"type": "tool_result", "tool_use_id": tool.id, "content": result}
            )
        messages.append({"role": "user", "content": tool_results})

    return messages


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("請先設定 ANTHROPIC_API_KEY 環境變數(可參考 .env.example)")
        sys.exit(1)

    client = anthropic.Anthropic()
    messages: list = []

    print("網頁搜尋助手已啟動,輸入問題開始對話(輸入 exit 離開)\n")
    while True:
        try:
            user_input = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if user_input.lower() in {"exit", "quit"}:
            break
        if not user_input:
            continue

        messages.append({"role": "user", "content": user_input})
        try:
            messages = run_turn(client, messages)
        except anthropic.APIError as e:
            print(f"\n[API 錯誤] {e}")


if __name__ == "__main__":
    main()
