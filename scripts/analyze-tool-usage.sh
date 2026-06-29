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
echo "--- CLI 工具使用统计 ---"
jq -r 'select(.cli != null) | "\(.cli)  [\(.role)]"' "$LOG_FILE" 2>/dev/null | sort | uniq -c | sort -rn | head -15 | while read count line; do
  printf "  %3s 次  %s\n" "$count" "$line"
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

echo ""
echo "--- 索引搜索调用 ---"
INDEX_SEARCH=$(jq -r 'select(.index_search) | "\(.index_search)|\(.search_query // "?")|topk=\(.search_top_k // "default")"' "$LOG_FILE" 2>/dev/null)
if [ -n "$INDEX_SEARCH" ]; then
  echo "$INDEX_SEARCH" | sort | uniq -c | sort -rn | head -15 | while read count line; do
    printf "  %2s 次  %s\n" "$count" "$line"
  done
else
  echo "  无索引搜索记录（需运行 match_cli.py / match_skills.py）"
fi

echo ""
echo "--- 搜索结果（热门匹配工具）---"
SR=".ralph/search-results.jsonl"
if [ -f "$SR" ]; then
  TOTAL_SR=$(wc -l < "$SR" | tr -d ' ')
  echo "  搜索日志条目: $TOTAL_SR"
  jq -r '.matched[]' "$SR" 2>/dev/null | sort | uniq -c | sort -rn | head -10 | while read count tool; do
    printf "  %3s 次  %s\n" "$count" "$tool"
  done
else
  echo "  无搜索结果日志"
fi

echo ""
echo "--- CLI 工具使用统计 ---"
CLI_LOG=".ralph/cli-calls.jsonl"
if [ -f "$CLI_LOG" ]; then
  CLI_TOTAL=$(wc -l < "$CLI_LOG" | tr -d ' ')
  echo "  CLI 调用总数: $CLI_TOTAL"
  echo "  按工具分布:"
  jq -r '.tool' "$CLI_LOG" 2>/dev/null | sort | uniq -c | sort -rn | head -15 | while read count tool; do
    printf "    %3s 次  %s\n" "$count" "$tool"
  done
  echo ""
  echo "  按规则分布:"
  jq -r '.rule' "$CLI_LOG" 2>/dev/null | sort | uniq -c | sort -rn | while read count rule; do
    printf "    %3s 次  %s\n" "$count" "$rule"
  done
  echo ""
  echo "  最近 CLI 调用:"
  jq -r '"    [\(.role)] \(.tool)\(.site // "")\(" " + .site // "")\(" " + .cmd // "") — \(.full_command[0:80])"' "$CLI_LOG" 2>/dev/null | tail -10
else
  echo "  无 CLI 调用日志"
fi
