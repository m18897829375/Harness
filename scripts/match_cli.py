"""
BM25 CLI 统一检索引擎 CLI。
搜索 cli-index.json + OpenCLI + MCP README 三个数据源。

用法:
    python3 scripts/match_cli.py "git clone repository"
    python3 scripts/match_cli.py --json --top-k 10 "deploy to cloud"
    python3 scripts/match_cli.py --source native,opencli "package manager"
    python3 scripts/match_cli.py --source mcp "browser automation"
    python3 scripts/match_cli.py --name "git clone"
    python3 scripts/match_cli.py --rebuild
"""
import argparse, json, math, os, re, sys, subprocess
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
INDEX_PATH = BASE / "cli-match-index.json"
K1 = 1.5
B = 0.75
MCP_WEIGHT = 0.7  # MCP 未转化条目的降权系数

STOP_WORDS = {
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
    'and', 'or', 'but', 'not', 'no', 'if', 'so', 'it', 'its',
    'i', 'we', 'you', 'he', 'she', 'they', 'my', 'our', 'your', 'their',
    'this', 'that', 'these', 'those', 'can', 'will', 'may', 'could', 'would',
    'into', 'over', 'up', 'out', 'all', 'has', 'had', 'do', 'does', 'did',
    'also', 'very', 'just', 'then', 'than', 'more', 'some', 'any', 'each',
    'use', 'when', 'need', 'how', 'what', 'get', 'set', 'using',
    'server', 'servers', 'tool', 'tools', 'api', 'access', 'support',
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
    '没有', '看', '好', '自己', '这', '他', '她', '它', '们',
}

SOURCE_BADGE = {
    'native-cli': '[CLI]',
    'opencli': '[OpenCLI]',
    'mcp': '[MCP→CLI]',
}


def tokenize(text):
    """中英文混合分词。"""
    tokens = []
    segments = re.split(r'([一-鿿]+)', text.lower())
    for seg in segments:
        if not seg.strip():
            continue
        if re.match(r'[一-鿿]+', seg):
            for i in range(len(seg) - 1):
                tokens.append(seg[i:i + 2])
        else:
            words = re.findall(r'[a-z0-9]+', seg.replace('-', ' ').replace('_', ' '))
            for w in words:
                if w not in STOP_WORDS and len(w) >= 2:
                    tokens.append(w)
    return tokens


def load_index():
    """加载 cli-match-index.json，不存在则自动构建。"""
    if not INDEX_PATH.exists():
        print("cli-match-index.json 不存在，自动构建...", file=sys.stderr)
        r = subprocess.run(
            [sys.executable, str(BASE / "scripts" / "build_cli_match_index.py")],
            capture_output=True, text=True)
        if r.returncode != 0:
            print(f"构建失败: {r.stderr}", file=sys.stderr)
            sys.exit(1)
        print(r.stdout.strip(), file=sys.stderr)
    with open(INDEX_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def bm25_score(sid, qtoks, idx):
    """BM25 打分。"""
    doc_len = idx['doc_lengths'][sid]
    doc_tokens = idx['doc_tokens'][sid]
    avgdl = idx['avg_doc_length']
    idf_map = idx['idf']
    score = 0.0
    for qt in qtoks:
        if qt not in idf_map:
            continue
        tf = sum(1 for t in doc_tokens if t == qt)
        if tf == 0:
            continue
        score += idf_map[qt] * tf * (K1 + 1) / (tf + K1 * (1 - B + B * doc_len / avgdl))
    return score


def search(query, idx, top_k=5, source_filter=None):
    """
    BM25 搜索，支持来源过滤和 MCP 降权。

    source_filter: None（全部）| ['native-cli'] | ['native-cli', 'opencli'] | ['mcp']
    """
    qtoks = tokenize(query)
    if not qtoks:
        return []

    inverted = idx['inverted']
    candidates = set()
    for qt in qtoks:
        if qt in inverted:
            candidates.update(inverted[qt])

    # 降级：前缀匹配
    if not candidates:
        for qt in qtoks:
            pref = qt[:4]
            for term, posting in inverted.items():
                if term.startswith(pref):
                    candidates.update(posting)

    if not candidates:
        return []

    scored = []
    for sid in candidates:
        entry = idx['entries'][sid]

        # 来源过滤
        if source_filter is not None and entry['source'] not in source_filter:
            continue

        score = bm25_score(sid, qtoks, idx)

        # MCP 降权
        if entry['source'] == 'mcp' and not entry.get('mcp_converted', False):
            score *= MCP_WEIGHT

        if score > 0:
            scored.append((sid, score))

    scored.sort(key=lambda x: x[1], reverse=True)

    # 去重 + Top-K
    results = []
    seen = set()
    for sid, score in scored:
        entry = idx['entries'][sid]
        name = entry['name']
        if name in seen:
            continue
        seen.add(name)

        r = {
            'rank': len(results) + 1,
            'name': name,
            'source': entry['source'],
            'type': entry.get('type', 'cli'),
            'score': round(score, 3),
            'description': entry.get('description_preview', '')[:120],
            'category': entry.get('category', ''),
            'commands': entry.get('commands', []),
        }

        # MCP 特有字段
        if entry['source'] == 'mcp':
            r['mcp_url'] = entry.get('mcp_url')
            r['mcp_install_cmd'] = entry.get('mcp_install_cmd')
            r['mcp_converted'] = entry.get('mcp_converted', False)
            r['has_native_equivalent'] = entry.get('has_native_equivalent', False)

        results.append(r)

        if len(results) >= top_k:
            break

    return results


def search_by_name(name, idx):
    """精确名称查找。"""
    ni = idx.get('name_index', {})
    if name not in ni:
        return []

    results = []
    for sid in ni[name]:
        entry = idx['entries'][sid]
        r = {
            'rank': len(results) + 1,
            'name': entry['name'],
            'source': entry['source'],
            'type': entry.get('type', 'cli'),
            'score': None,
            'description': entry.get('description_preview', '')[:120],
            'category': entry.get('category', ''),
            'commands': entry.get('commands', []),
        }
        if entry['source'] == 'mcp':
            r['mcp_url'] = entry.get('mcp_url')
            r['mcp_install_cmd'] = entry.get('mcp_install_cmd')
            r['mcp_converted'] = entry.get('mcp_converted', False)
        results.append(r)

    return results


def rebuild():
    """重建 cli-match-index.json。"""
    print("重建 cli-match-index.json ...", file=sys.stderr)
    r = subprocess.run(
        [sys.executable, str(BASE / "scripts" / "build_cli_match_index.py")],
        capture_output=True, text=True)
    print(r.stdout.strip(), file=sys.stderr)
    if r.returncode != 0:
        print(f"构建失败: {r.stderr}", file=sys.stderr)
        sys.exit(r.returncode)


def _format_text(results):
    """文本格式输出。"""
    for r in results:
        badge = SOURCE_BADGE.get(r['source'], '[?]')
        extra = ''
        if r['source'] == 'mcp':
            if r.get('mcp_converted'):
                extra = ' [已转化]'
            else:
                extra = ' [待转化]'

        print(f"{r['rank']:2d}. {badge} {r['name']}{extra} (score={r['score']})")

        if r.get('description'):
            print(f"    {r['description']}")

        for cmd in r.get('commands', [])[:3]:
            if cmd.get('usage'):
                print(f"    用法: {cmd['usage']}")

        if r['source'] == 'mcp':
            if r.get('mcp_url'):
                print(f"    GitHub: {r['mcp_url']}")
            if r.get('mcp_install_cmd'):
                print(f"    安装: {r['mcp_install_cmd']}")
            if not r.get('mcp_converted') and not r.get('has_native_equivalent'):
                print(f"    提示: 可通过 OpenCLI 适配器机制转化为 CLI")

        print()


LOGIN_STRATEGIES = {'cookie', 'ui', 'intercept'}

STRATEGY_CN = {
    'cookie': '需浏览器 Cookie（先登录站点）',
    'ui': '需浏览器交互/OAuth 登录',
    'intercept': '需拦截请求（需已登录会话）',
    'public': '无需登录',
    'local': '本地服务',
}

def _preflight(idx, login_only=False, install_only=False):
    """预检：列出需要用户登录/安装的 CLI/MCP 工具。"""
    entries = idx['entries']
    show_all = not login_only and not install_only

    # ── 需要登录的工具 ──────────────────────────────────────────
    if show_all or login_only:
        login_entries = [e for e in entries
                         if e.get('strategy') in LOGIN_STRATEGIES]
        if login_entries:
            print("=== 需要用户登录的 CLI/MCP 工具 ===\n")
            for e in sorted(login_entries, key=lambda x: x['name']):
                badge = SOURCE_BADGE.get(e['source'], '[?]')
                st = e.get('strategy', '')
                domain = e.get('domain', '') or ''
                print(f"  {badge} {e['name']}")
                print(f"     策略: {STRATEGY_CN.get(st, st)}")
                if domain:
                    print(f"     域名: {domain}")
                if e.get('mcp_url'):
                    print(f"     GitHub: {e['mcp_url']}")
                print()
            print(f"  共 {len(login_entries)} 个工具需要登录\n")
        else:
            print("=== 需要用户登录的 CLI/MCP 工具 ===\n  无\n")

    # ── 需要安装的工具 ──────────────────────────────────────────
    if show_all or install_only:
        install_entries = [e for e in entries
                           if e.get('install_required') or e.get('mcp_install_cmd')]
        if install_entries:
            print("=== 需要用户安装/配置的 CLI/MCP 工具 ===\n")
            for e in sorted(install_entries, key=lambda x: x['name']):
                badge = SOURCE_BADGE.get(e['source'], '[?]')
                print(f"  {badge} {e['name']}")
                if e.get('mcp_install_cmd'):
                    print(f"     安装: {e['mcp_install_cmd']}")
                if e.get('mcp_url'):
                    print(f"     GitHub: {e['mcp_url']}")
                if e.get('install_required') and not e.get('mcp_install_cmd'):
                    print(f"     需用户手动安装（{e.get('category', '')}）")
                print()
            print(f"  共 {len(install_entries)} 个工具需要安装/配置\n")
        else:
            print("=== 需要用户安装/配置的 CLI/MCP 工具 ===\n  无\n")

    if show_all:
        print("提示：请在启动 Ralph Loop 前完成以上准备工作，避免 gen/eva 卡住。")


def main():
    p = argparse.ArgumentParser(
        description="BM25 CLI Unified Search — 搜索 native CLI + OpenCLI + MCP")
    p.add_argument("query", nargs="?", help="搜索查询词（如 'git clone'）")
    p.add_argument("--json", action="store_true", help="JSON 格式输出")
    p.add_argument("--top-k", type=int, default=3, help="返回结果数（默认 3）")
    p.add_argument("--source", help="来源过滤: native,opencli,mcp（逗号分隔）")
    p.add_argument("--name", help="精确名称查找")
    p.add_argument("--rebuild", action="store_true", help="重建 cli-match-index.json")
    p.add_argument("--show-mcp", action="store_true", help="仅显示 MCP 条目")
    p.add_argument("--list", action="store_true", help="浏览模式：列出索引中所有条目")
    p.add_argument("--category", help="分类过滤（用于 --list 和搜索）")
    p.add_argument("--needs-login", action="store_true", help="预检：列出需要用户登录的工具")
    p.add_argument("--needs-install", action="store_true", help="预检：列出需要用户安装/配置的工具")
    p.add_argument("--preflight", action="store_true", help="预检：一键输出完整预检清单")

    args = p.parse_args()

    if args.rebuild:
        rebuild()
        return

    idx = load_index()

    # 来源过滤
    source_filter = None
    if args.source:
        source_filter = [s.strip() for s in args.source.split(',')]
    if args.show_mcp:
        source_filter = ['mcp']

    # ── 预检模式 ──────────────────────────────────────────────────
    if args.needs_login or args.needs_install or args.preflight:
        _preflight(idx, login_only=args.needs_login,
                   install_only=args.needs_install)
        return

    # --list 浏览模式：列出索引中所有条目
    if args.list:
        entries = idx['entries']
        if source_filter:
            entries = [e for e in entries if e['source'] in source_filter]
        if args.category:
            entries = [e for e in entries if e.get('category') == args.category]
        if args.json:
            print(json.dumps({"total": len(entries), "entries": entries}, ensure_ascii=False, indent=2))
        else:
            for e in entries:
                badge = SOURCE_BADGE.get(e['source'], '[?]')
                print(f"{badge} {e['name']}  [{e.get('category', '')}]")
                if e.get('description_preview'):
                    print(f"    {e['description_preview'][:100]}")
        return

    if args.name:
        results = search_by_name(args.name, idx)
        if source_filter:
            results = [r for r in results if r['source'] in source_filter]
    elif args.query:
        results = search(args.query, idx, args.top_k, source_filter)
    else:
        sc = idx.get('sources', {})
        print(f"cli-match-index.json: {idx['total_entries']} 条目, "
              f"{len(idx['inverted'])} 词汇")
        print(f"  native-cli: {sc.get('native-cli', 0)}")
        print(f"  opencli:    {sc.get('opencli', 0)}")
        print(f"  mcp:        {sc.get('mcp', 0)}")
        print(f"  构建时间:   {idx.get('built_at', 'unknown')}")
        print()
        print("用法: python3 scripts/match_cli.py \"<查询词>\"")
        print("      python3 scripts/match_cli.py --source mcp \"<查询词>\"")
        print("      python3 scripts/match_cli.py --name \"<精确名称>\"")
        return

    if not results:
        if args.json:
            print(json.dumps({"query": args.query or args.name, "matched": [], "note": "no results"},
                           ensure_ascii=False))
        else:
            print("无匹配结果")
        return

    if args.json:
        output = {
            "query": args.query or f"name:{args.name}",
            "total_in_index": idx['total_entries'],
            "sources_in_index": idx.get('sources', {}),
            "matched": results,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        _format_text(results)

    # 写入搜索结果日志（供 analyze-tool-usage.sh 统计）
    ralph_dir = BASE / ".ralph"
    if ralph_dir.exists() and results:
        import datetime as dt
        log_entry = {
            "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
            "script": "match_cli",
            "query": args.query or args.name,
            "source_filter": source_filter,
            "matched": [r["name"] for r in results[:args.top_k]],
        }
        with open(ralph_dir / "search-results.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(log_entry, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
