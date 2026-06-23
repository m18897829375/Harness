#!/usr/bin/env python3
"""搜索 skill-index.json 和 cli-index.json 的 CLI 工具。

用法:
  python3 scripts/search_index.py --type skill --keyword "test"
  python3 scripts/search_index.py --type skill --keyword "test" --category "testing"
  python3 scripts/search_index.py --type skill --keyword "deploy" --phase "generator"
  python3 scripts/search_index.py --type cli --keyword "git"
  python3 scripts/search_index.py --type skill --name "git-workflow"
  python3 scripts/search_index.py --type skill --keyword "test" --format json
"""

import argparse
import json
import re
import sys
from pathlib import Path

# 项目根目录（脚本在 scripts/ 下）
PROJECT_DIR = Path(__file__).resolve().parent.parent

# category 中英双向映射
CATEGORY_MAP = {
    "development": "开发", "开发": "development",
    "testing": "测试", "测试": "testing",
    "deployment": "部署", "部署": "deployment",
    "security": "安全", "安全": "security",
    "performance": "性能", "性能": "performance",
    "database": "数据库", "数据库": "database",
    "management": "管理", "管理": "management",
    "marketing": "营销", "营销": "marketing",
    "finance": "金融", "金融": "finance",
    "compliance": "合规", "合规": "compliance",
    "healthcare": "医疗", "医疗": "healthcare",
    "requirements": "需求分析", "需求分析": "requirements",
}


def load_index(index_type):
    """加载索引文件。"""
    filename = "skill-index.json" if index_type == "skill" else "cli-index.json"
    path = PROJECT_DIR / filename
    if not path.exists():
        print(f"ERROR: {path} not found", file=sys.stderr)
        sys.exit(1)
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    key = "skills" if index_type == "skill" else "tools"
    return data.get(key, [])


def tokenize(keyword):
    """分词：中英文自动分离。"""
    return re.findall(r'[一-鿿]+|[a-zA-Z0-9_.-]+', keyword)


def build_regex(tokens):
    """构建 AND 语义正则（所有 token 必须同时出现，顺序无关）。"""
    parts = []
    for t in tokens:
        # 转义特殊字符
        escaped = re.escape(t)
        parts.append(f"(?=.*{escaped})")
    return re.compile(f"(?i){''.join(parts)}.*")


def match_entry(entry, regex, index_type):
    """在条目的可搜索字段中匹配。返回 (name_match, kw_match, desc_match)。"""
    name = entry.get("name", "")
    desc = entry.get("description", "")
    kw_text = " ".join(entry.get("trigger_keywords", []))

    name_hit = bool(regex.search(name))
    kw_hit = bool(regex.search(kw_text)) if kw_text else False
    desc_hit = bool(regex.search(desc))

    return name_hit, kw_hit, desc_hit


def score_entry(name_hit, kw_hit, desc_hit):
    """加权打分：name(+2) > keywords(+1) > desc(+0)，加匹配字段数。"""
    fields = sum([name_hit, kw_hit, desc_hit])
    bonus = (2 if name_hit else 0) + (1 if kw_hit else 0)
    return fields + bonus


def resolve_category(cat):
    """解析 category：支持中/英文 + 双向映射。"""
    return CATEGORY_MAP.get(cat, cat)


def search(index_type, keyword=None, name=None, category=None, phase=None, fmt="names"):
    """主搜索函数。"""
    entries = load_index(index_type)

    results = []

    if name:
        # 精确 name 匹配
        regex = re.compile(f"^{re.escape(name)}$", re.IGNORECASE)
        for entry in entries:
            if regex.match(entry.get("name", "")):
                results.append((entry, 10, True, True, False))
    elif keyword:
        tokens = tokenize(keyword)
        if not tokens:
            print("ERROR: keyword contains no searchable tokens", file=sys.stderr)
            sys.exit(1)

        regex = build_regex(tokens)

        for entry in entries:
            name_hit, kw_hit, desc_hit = match_entry(entry, regex, index_type)
            if name_hit or kw_hit or desc_hit:
                score = score_entry(name_hit, kw_hit, desc_hit)
                results.append((entry, score, name_hit, kw_hit, desc_hit))
    else:
        print("ERROR: --keyword or --name required", file=sys.stderr)
        sys.exit(1)

    # category 过滤
    if category:
        target_cats = [resolve_category(c.strip()) for c in category.split(",")]
        results = [
            r for r in results
            if r[0].get("category", "") in target_cats
            or resolve_category(r[0].get("category", "")) in target_cats
        ]

    # phase 过滤
    if phase and index_type == "skill":
        results = [r for r in results if r[0].get("phase", "") == phase]

    # 按 score 降序排列
    results.sort(key=lambda r: r[1], reverse=True)

    # 输出
    if fmt == "json":
        output = [r[0] for r in results]
        print(json.dumps(output, ensure_ascii=False, indent=2))
    elif fmt == "detail":
        for entry, score, name_hit, kw_hit, desc_hit in results:
            print(f"--- {entry['name']} (score={score}, name={name_hit}, kw={kw_hit}, desc={desc_hit})")
            print(f"    category: {entry.get('category', 'N/A')}")
            if index_type == "skill":
                print(f"    phase: {entry.get('phase', 'N/A')}")
            print(f"    description: {entry.get('description', 'N/A')[:120]}")
            if index_type == "skill":
                print(f"    file_path: {entry.get('file_path', 'N/A')}")
            else:
                cmd_names = [c.get("name", "") for c in entry.get("commands", [])]
                print(f"    commands: {', '.join(cmd_names)}")
            print()
    else:
        # names only
        for entry, score, _, _, _ in results:
            cat = entry.get("category", "")
            ph = entry.get("phase", "") if index_type == "skill" else ""
            extra = f" [{cat}][{ph}]" if ph else f" [{cat}]"
            print(f"{entry['name']}{extra}")

    return results


def main():
    parser = argparse.ArgumentParser(description="搜索 skill 和 CLI 索引表")
    parser.add_argument("--type", choices=["skill", "cli"], required=True,
                        help="索引类型：skill 或 cli")
    parser.add_argument("--keyword", help="搜索关键词（英文优先）")
    parser.add_argument("--name", help="精确匹配 name 字段")
    parser.add_argument("--category", help="按 category 过滤（支持中/英文）")
    parser.add_argument("--phase", help="按 phase 过滤（仅 skill 类型）")
    parser.add_argument("--format", choices=["names", "json", "detail"],
                        default="names", help="输出格式（默认 names）")

    args = parser.parse_args()
    search(
        index_type=args.type,
        keyword=args.keyword,
        name=args.name,
        category=args.category,
        phase=args.phase,
        fmt=args.format,
    )


if __name__ == "__main__":
    main()
