#!/bin/bash
# analyze-tool-usage.sh — 分析 Ralph Loop 工具调用日志
# 用法: bash scripts/analyze-tool-usage.sh [.ralph/tool-calls.jsonl]

LOG_FILE="${1:-.ralph/tool-calls.jsonl}"

if [ ! -f "$LOG_FILE" ]; then
  echo "Log file not found: $LOG_FILE"
  echo "Run Ralph Loop first, then re-run this script."
  exit 1
fi

TOTAL=$(wc -l < "$LOG_FILE" | tr -d ' ')
if [ "$TOTAL" -eq 0 ]; then
  echo "Log file is empty. No tool calls recorded."
  exit 0
fi

echo "=== Ralph Loop 工具调用统计 ==="
echo "总调用次数: $TOTAL"
echo ""
echo "--- 按角色分布 ---"
jq -r '.role' "$LOG_FILE" | sort | uniq -c | sort -rn | while read count role; do
  echo "  $role: $count 次"
done

echo ""
echo "--- 按工具类型分布 ---"
jq -r '"\(.role)|\(.tool)"' "$LOG_FILE" | sort | uniq -c | sort -rn | while read count combo; do
  role="${combo%%|*}"
  tool="${combo##*|}"
  printf "  %-12s %-20s %s 次\n" "[$role]" "$tool" "$count"
done

echo ""
echo "--- Agent 调用详情 ---"
jq -r 'select(.tool == "Agent") | "  [\(.role)] \(.agent // "unknown") — \(.params // "")"' "$LOG_FILE" | sort | uniq -c | sort -rn

echo ""
echo "--- Skill 调用详情 ---"
jq -r 'select(.tool == "Skill") | "  [\(.role)] \(.skill // "unknown")"' "$LOG_FILE" | sort | uniq -c | sort -rn

echo ""
echo "--- Bash 命令摘要 ---"
jq -r 'select(.tool == "Bash") | "  [\(.role)] \(.command // .params // "n/a")"' "$LOG_FILE" | head -20

echo ""
echo "--- 时间分布 ---"
FIRST=$(jq -r '.ts' "$LOG_FILE" | head -1)
LAST=$(jq -r '.ts' "$LOG_FILE" | tail -1)
echo "  开始: $FIRST"
echo "  结束: $LAST"
