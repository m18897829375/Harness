"""
从 3 个数据源构建 CLI BM25 倒排索引 cli-match-index.json。

数据源:
  1. cli-index.json — 35 个 CLI 工具（~280 条子命令）
  2. subprojects/OpenCLI/cli-manifest.json — ~1049 条适配器命令
  3. subprojects/awesome-mcp-servers/README.md — ~2425 个 MCP 服务器

用法:
    python3 scripts/build_cli_match_index.py
    python3 scripts/build_cli_match_index.py --input-cli cli-index.json --output cli-match-index.json
"""
import json, math, re, sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent

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

# MCP README 分类 → 标准 13 分类映射
MCP_CATEGORY_MAP = {
    'aggregators': 'agent-ops',
    'art-and-culture': 'api-client',
    'architecture-and-design': 'code-quality',
    'biology-medicine-and-bioinformatics': 'data-processing',
    'browser-automation': 'browser-automation',
    'cloud-platforms': 'deployment',
    'code-execution': 'runtime',
    'coding-agents': 'agent-ops',
    'command-line': 'shell',
    'communication': 'api-client',
    'conversational-ai': 'agent-ops',
    'cryptography': 'code-quality',
    'customer-data-platforms': 'data-processing',
    'databases': 'data-processing',
    'data-platforms': 'data-processing',
    'data-science-tools': 'data-processing',
    'data-visualization': 'data-processing',
    'delivery': 'deployment',
    'developer-tools': 'agent-ops',
    'embedded-system': 'runtime',
    'education': 'api-client',
    'e-commerce': 'api-client',
    'environment-and-nature': 'api-client',
    'file-systems': 'data-processing',
    'finance--fintech': 'data-processing',
    'gaming': 'api-client',
    'home-automation': 'runtime',
    'knowledge--memory': 'data-processing',
    'legal': 'api-client',
    'location-services': 'api-client',
    'marketing': 'api-client',
    'monitoring': 'agent-ops',
    'multimedia-process': 'data-processing',
    'os-automation': 'runtime',
    'product-management': 'agent-ops',
    'real-estate': 'api-client',
    'research': 'agent-ops',
    'search': 'data-processing',
    'security': 'code-quality',
    'social-media': 'api-client',
    'sports': 'api-client',
    'support-and-service-management': 'agent-ops',
    'translation-services': 'api-client',
    'text-to-speech': 'data-processing',
    'speech-to-text': 'data-processing',
    'travel-and-transportation': 'api-client',
    'version-control': 'version-control',
    'workplace-and-productivity': 'agent-ops',
    'other-tools-and-integrations': 'agent-ops',
    'rag': 'data-processing',
}

SOURCE_PRIORITY = {'native-cli': 3, 'opencli': 2, 'mcp': 1}


def tokenize(text):
    """中英文混合分词：英文按 - _ 和单词边界分，中文按 2-gram。"""
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


# ── 数据源解析 ────────────────────────────────────────────

def parse_cli_index(path):
    """解析 cli-index.json，每个 command 展开为独立条目。"""
    with open(path, 'r', encoding='utf-8-sig') as f:
        data = json.load(f)

    entries = []
    for tool in data.get('tools', []):
        tname = tool['name']
        tdesc = tool.get('description', '')
        tcat = tool.get('category', 'agent-ops')
        tsrc = tool.get('source', 'native-cli')
        tinstall = tool.get('install_required', False)
        orig_mcp = tool.get('original_mcp')

        for cmd in tool.get('commands', []):
            cname = cmd['name']
            cdesc = cmd.get('description', '')
            cusage = cmd.get('usage', '')

            entries.append({
                'id': f"native:{tname}:{cname}",
                'name': f"{tname} {cname}",
                'source': tsrc,
                'type': 'cli',
                'description': tdesc,
                'category': tcat,
                'commands': [{'name': cname, 'usage': cusage, 'desc': cdesc}],
                'install_required': tinstall,
                'original_mcp': orig_mcp,
                'mcp_url': None,
                'mcp_install_cmd': None,
                'mcp_tags': [],
                '_search_doc': '',
            })

    return entries


def parse_opencli_manifest(path):
    """解析 cli-manifest.json，每个 adapter command 为一个条目。"""
    with open(path, 'r', encoding='utf-8-sig') as f:
        manifest = json.load(f)

    entries = []
    for cmd in manifest:
        site = cmd.get('site', '')
        name = cmd.get('name', '')
        desc = cmd.get('description', '')
        domain = cmd.get('domain', '')
        args = cmd.get('args', [])

        # 收集 args help 文本
        args_help = ' '.join(a.get('help', '') for a in args if a.get('help'))

        entries.append({
            'id': f"opencli:{site}:{name}",
            'name': f"opencli {site} {name}",
            'source': 'opencli',
            'type': 'cli',
            'description': desc,
            'category': _map_opencli_category(site),
            'commands': [{'name': name, 'usage': f"opencli {site} {name}", 'desc': desc}],
            'install_required': True,
            'install_cmd': 'npm install -g @jackwener/opencli',
            'original_mcp': None,
            'mcp_url': None,
            'mcp_install_cmd': None,
            'mcp_tags': [],
            'domain': domain,
            'site': site,
            'strategy': cmd.get('strategy'),
            'args_help': args_help,
            '_search_doc': '',
        })

    return entries


def parse_mcp_readme(path):
    """解析 awesome-mcp-servers/README.md，提取 MCP 服务器条目。"""
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    # 匹配条目行: - [owner/repo](github_url) ... - description
    MCP_ENTRY_RE = re.compile(
        r'^-\s+\[(?P<display>[^\]]+)\]'
        r'\(https://github\.com/(?P<repo_path>[^/]+/[^/)]+)\)'
        r'.*?-\s+(?P<desc>.+)$',
        re.MULTILINE
    )

    # 匹配分类标题: ### emoji <a name="anchor"></a>Title
    SECTION_RE = re.compile(
        r'^###\s+.*?<a\s+name="(?P<anchor>[^"]+)"></a>(?P<title>.*)$',
        re.MULTILINE
    )

    # 提取 install 命令
    INSTALL_RE = re.compile(
        r'`((?:npx\s+(?:-y\s+)?\S+|npm\s+(?:install|i|run)\s+\S+|'
        r'pip\s+(?:install|pipx\s+install)\s+\S+|'
        r'pnpm\s+(?:dlx|add)\s+\S+|'
        r'yarn\s+(?:dlx|add)\s+\S+|'
        r'bun\s+x\s+\S+|'
        r'go\s+install\s+\S+|'
        r'cargo\s+install\s+\S+))`'
    )

    # Emoji tags
    TAGS_RE = re.compile(r'[📇🐍🏎️🦀#️⃣☕🌊💎☁️🏠📟🍎🪟🐧🎖️]')

    # 构建 section anchor → category 映射
    section_map = {}
    for m in SECTION_RE.finditer(content):
        anchor = m.group('anchor')
        cat = MCP_CATEGORY_MAP.get(anchor, 'agent-ops')
        section_map[anchor] = cat

    # 跟踪当前 section
    current_anchor = 'other'
    entries = []

    for line in content.split('\n'):
        # 检测 section 切换
        sec_match = SECTION_RE.match(line.strip())
        if sec_match:
            current_anchor = sec_match.group('anchor')
            continue

        # 检测条目
        entry_match = MCP_ENTRY_RE.match(line.strip())
        if not entry_match:
            continue

        repo_path = entry_match.group('repo_path')
        desc = entry_match.group('desc').strip()

        # 提取 tags
        tags = TAGS_RE.findall(line)

        # 提取 install 命令
        install_cmd = None
        im = INSTALL_RE.search(line)
        if im:
            install_cmd = im.group(1)

        # 清理 display name
        display = entry_match.group('display')
        parts = display.split('/')
        repo_name = parts[-1] if len(parts) > 1 else display
        for suffix in ['-mcp', '-server', '-mcp-server']:
            if repo_name.endswith(suffix):
                repo_name = repo_name[:-len(suffix)]
                break

        category = section_map.get(current_anchor, 'agent-ops')

        entries.append({
            'id': f"mcp:{repo_path}",
            'name': repo_name,
            'source': 'mcp',
            'type': 'mcp',
            'description': desc,
            'category': category,
            'commands': [],
            'install_required': True,
            'install_cmd': install_cmd,
            'original_mcp': None,
            'mcp_url': f"https://github.com/{repo_path}",
            'mcp_install_cmd': install_cmd,
            'mcp_tags': tags,
            'mcp_converted': False,
            '_search_doc': '',
        })

    return entries


# ── 分类映射 ──────────────────────────────────────────────

def _map_opencli_category(site):
    """将 OpenCLI site 映射到标准分类。"""
    site_map = {
        'github': 'version-control',
        'gitlab': 'version-control',
        'npm': 'package-manager',
        'pypi': 'package-manager',
        'dockerhub': 'deployment',
        'playwright': 'browser-automation',
        'browser': 'browser-automation',
        'v2ray': 'agent-ops',
        'twitter': 'api-client',
        'reddit': 'api-client',
        'youtube': 'api-client',
        'bilibili': 'api-client',
        'zhihu': 'api-client',
    }
    return site_map.get(site.lower(), 'api-client')


# ── 去重 ──────────────────────────────────────────────────

def deduplicate(entries):
    """三源去重：native-cli > opencli > mcp 优先级。"""
    name_groups = defaultdict(list)
    for e in entries:
        norm = e['name'].lower().replace('-', ' ').replace('_', ' ')
        name_groups[norm].append(e)

    kept = []
    for norm, group in name_groups.items():
        if len(group) == 1:
            kept.append(group[0])
        else:
            group.sort(key=lambda e: SOURCE_PRIORITY.get(e['source'], 0), reverse=True)
            best = group[0]
            kept.append(best)
            for other in group[1:]:
                if other['source'] == 'mcp':
                    other['has_native_equivalent'] = True
                    kept.append(other)

    return kept


# ── 搜索文档构建 ──────────────────────────────────────────

def build_search_doc(entry):
    """构建 BM25 搜索文档，name 高权重，commands 次之。"""
    parts = []

    if entry['source'] == 'native-cli':
        parts.extend([entry['name']] * 3)
        parts.append(entry['description'])
        for cmd in entry.get('commands', []):
            parts.extend([cmd['name']] * 2)
            parts.append(cmd.get('desc', ''))
        # category ×2 增强分类匹配
        parts.extend([entry.get('category', '')] * 2)

    elif entry['source'] == 'opencli':
        parts.extend([entry['name']] * 3)
        parts.append(entry['description'])
        parts.append(entry.get('site', ''))
        parts.append(entry.get('args_help', ''))

    elif entry['source'] == 'mcp':
        mcp_url = entry.get('mcp_url', '')
        repo = mcp_url.replace('https://github.com/', '') if mcp_url else ''
        parts.extend([repo] * 2)
        parts.append(entry['description'])
        parts.extend(entry.get('mcp_tags', []))
        if entry.get('mcp_install_cmd'):
            parts.append(entry['mcp_install_cmd'])

    return ' '.join(parts)


# ── 主构建函数 ────────────────────────────────────────────

def build_cli_match_index(
    cli_index_path=None,
    opencli_manifest_path=None,
    mcp_readme_path=None,
    output_path=None,
):
    cli_index_path = cli_index_path or str(BASE / 'cli-index.json')
    opencli_manifest_path = opencli_manifest_path or str(
        BASE / 'subprojects' / 'OpenCLI' / 'cli-manifest.json')
    mcp_readme_path = mcp_readme_path or str(
        BASE / 'subprojects' / 'awesome-mcp-servers' / 'README.md')
    output_path = output_path or str(BASE / 'cli-match-index.json')

    # 1. 解析三个数据源
    print("[1/8] 解析数据源 ...")
    cli_entries = parse_cli_index(cli_index_path)
    print(f"  cli-index.json: {len(cli_entries)} 条命令")

    opencli_entries = []
    if Path(opencli_manifest_path).exists():
        opencli_entries = parse_opencli_manifest(opencli_manifest_path)
        print(f"  cli-manifest.json: {len(opencli_entries)} 条命令")
    else:
        print(f"  cli-manifest.json: 未找到，跳过")

    mcp_entries = []
    if Path(mcp_readme_path).exists():
        mcp_entries = parse_mcp_readme(mcp_readme_path)
        print(f"  README.md: {len(mcp_entries)} 个 MCP 服务器")
    else:
        print(f"  README.md: 未找到，跳过")

    # 2. 合并
    print("\n[2/8] 合并条目 ...")
    all_entries = cli_entries + opencli_entries + mcp_entries
    print(f"  合并: {len(all_entries)} 条")

    # 3. 去重
    print("\n[3/8] 去重 ...")
    all_entries = deduplicate(all_entries)
    print(f"  去重: {len(all_entries)} 条")

    # 4. 构建搜索文档
    print("\n[4/8] 构建搜索文档 ...")
    for e in all_entries:
        e['_search_doc'] = build_search_doc(e)

    # 5. 分词
    print("[5/8] 分词 ...")
    doc_tokens = []
    doc_lengths = []
    for e in all_entries:
        tokens = tokenize(e['_search_doc'])
        doc_tokens.append(tokens)
        doc_lengths.append(len(tokens))

    avg_dl = sum(doc_lengths) / len(doc_lengths) if doc_lengths else 1.0
    print(f"  平均文档长度: {avg_dl:.1f} tokens")

    # 6. 倒排索引
    print("[6/8] 倒排索引 ...")
    inverted = defaultdict(set)
    for sid, tokens in enumerate(doc_tokens):
        for tok in set(tokens):
            inverted[tok].add(sid)
    inverted = {k: sorted(v) for k, v in inverted.items()}
    print(f"  词汇量: {len(inverted)}")

    # 7. IDF
    print("[7/8] IDF ...")
    N = len(all_entries)
    idf = {}
    for tok, posting in inverted.items():
        df = len(posting)
        idf[tok] = math.log((N - df + 0.5) / (df + 0.5) + 1.0)

    # 8. 序列化
    print("[8/8] 序列化 ...")
    source_counts = defaultdict(int)
    for e in all_entries:
        source_counts[e['source']] += 1

    output = {
        'version': datetime.now().isoformat(),
        'total_entries': N,
        'built_at': datetime.now().isoformat(),
        'source_files': {
            'cli_index': str(Path(cli_index_path).name),
            'opencli_manifest': str(Path(opencli_manifest_path).name) if Path(opencli_manifest_path).exists() else None,
            'mcp_readme': str(Path(mcp_readme_path).name) if Path(mcp_readme_path).exists() else None,
        },
        'sources': dict(source_counts),
        'avg_doc_length': avg_dl,
        'entries': [
            {
                'id': e['id'],
                'name': e['name'],
                'source': e['source'],
                'type': e.get('type', 'cli'),
                'category': e.get('category', ''),
                'description_preview': e.get('description', '')[:200],
                'mcp_url': e.get('mcp_url'),
                'mcp_install_cmd': e.get('mcp_install_cmd'),
                'mcp_converted': e.get('mcp_converted', False),
                'has_native_equivalent': e.get('has_native_equivalent', False),
                'install_required': e.get('install_required', False),
                'strategy': e.get('strategy'),
                'domain': e.get('domain'),
                'commands': e.get('commands', []),
            }
            for e in all_entries
        ],
        'name_index': _build_name_index(all_entries),
        'idf': idf,
        'doc_lengths': doc_lengths,
        'doc_tokens': doc_tokens,
        'inverted': inverted,
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    size_kb = Path(output_path).stat().st_size / 1024
    mcp_count = source_counts.get('mcp', 0)
    native_count = source_counts.get('native-cli', 0)
    opencli_count = source_counts.get('opencli', 0)
    print(f"\n输出: {output_path} ({size_kb:.0f} KB)")
    print(f"  native-cli: {native_count}, opencli: {opencli_count}, mcp: {mcp_count}")
    print(f"  总计: {N} 条目, {len(inverted)} 词汇")

    # 输出工具注册表（供 log-tool-call.js 识别 CLI 调用）
    native_names = sorted(set(
        e['name'].split()[0]
        for e in all_entries if e['source'] in ('native-cli', 'opencli-converted')
    ))
    opencli_sites = sorted(set(
        e.get('site', '') for e in all_entries if e['source'] == 'opencli' and e.get('site')
    ))
    registry = {
        "native_tools": native_names,
        "opencli_sites": opencli_sites,
    }
    reg_path = str(Path(output_path).parent / 'cli-tool-registry.json')
    with open(reg_path, 'w', encoding='utf-8') as f:
        json.dump(registry, f, ensure_ascii=False, indent=2)
    print(f"  工具注册表: {reg_path} (native={len(native_names)}, opencli_sites={len(opencli_sites)})")


def _build_name_index(entries):
    ni = defaultdict(list)
    for i, e in enumerate(entries):
        ni[e['name']].append(i)
    return {k: v for k, v in ni.items()}


if __name__ == '__main__':
    if '--help' in sys.argv or '-h' in sys.argv:
        print(__doc__)
        sys.exit(0)

    kwargs = {}
    args = sys.argv[1:]
    while args:
        if args[0] == '--input-cli' and len(args) > 1:
            kwargs['cli_index_path'] = args[1]; args = args[2:]
        elif args[0] == '--input-opencli' and len(args) > 1:
            kwargs['opencli_manifest_path'] = args[1]; args = args[2:]
        elif args[0] == '--input-mcp' and len(args) > 1:
            kwargs['mcp_readme_path'] = args[1]; args = args[2:]
        elif args[0] == '--output' and len(args) > 1:
            kwargs['output_path'] = args[1]; args = args[2:]
        else:
            args = args[1:]

    build_cli_match_index(**kwargs)
