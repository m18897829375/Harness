"""
从 skill-index.json 构建 BM25 倒排索引 match-index.json。

用法:
    python3 scripts/build_match_index.py
    python3 scripts/build_match_index.py --input skill-index.json --output match-index.json
"""
import json, math, re, sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent

# 停用词（中英文常见词，避免占用倒排索引空间）
STOP_WORDS = {
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as',
    'and', 'or', 'but', 'not', 'no', 'if', 'so', 'it', 'its',
    'i', 'we', 'you', 'he', 'she', 'they', 'my', 'our', 'your', 'their',
    'this', 'that', 'these', 'those', 'can', 'will', 'may', 'could', 'would',
    'into', 'over', 'up', 'out', 'all', 'has', 'had', 'do', 'does', 'did',
    'also', 'very', 'just', 'then', 'than', 'more', 'some', 'any', 'each',
    'use', 'when', 'need', 'how', 'what', 'get', 'set', 'using',
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
    '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
    '没有', '看', '好', '自己', '这', '他', '她', '它', '们',
}


def tokenize(text: str) -> list:
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


def text_similarity(a: str, b: str) -> float:
    """Jaccard token 相似度，用于判定 desc 是否实质相同。"""
    if not a or not b:
        return 0.0
    ta = set(tokenize(a))
    tb = set(tokenize(b))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def is_translation(file_path: str) -> bool:
    """检测是否为 ECC 多语言翻译路径（docs/XX/skills/）。"""
    normalized = file_path.replace('\\', '/')
    return '/docs/' in normalized and '/skills/' in normalized


def dedup_skills(skills: list) -> list:
    """
    构建前去重。
    同 name + 同 source + desc 相似 > 80% → 保留 file_path 最短的。
    同 name + 不同 source → 保留 desc 更长的。
    同 name + desc 差异大（不同 skill）→ 全部保留。
    """
    name_groups = defaultdict(list)
    for s in skills:
        name_groups[s['name']].append(s)

    kept = []
    for name, items in name_groups.items():
        if len(items) == 1:
            kept.append(items[0])
            continue

        # 按 source 分组
        by_source = defaultdict(list)
        for s in items:
            by_source[s['source']].append(s)

        # 每 source 内去重
        unique_per_source = {}
        for src, group in by_source.items():
            uniq = []
            for s in sorted(group, key=lambda x: len(x.get('file_path', ''))):
                dup = any(text_similarity(s.get('description', ''), u.get('description', '')) > 0.8
                         for u in uniq)
                if not dup:
                    uniq.append(s)
            unique_per_source[src] = uniq

        if len(unique_per_source) == 1:
            kept.extend(list(unique_per_source.values())[0])
        else:
            # 跨 source：保留 desc 最长的
            all_uniq = [(s, src) for src, group in unique_per_source.items() for s in group]
            best = max(all_uniq, key=lambda x: len(x[0].get('description', '')))
            kept.append(best[0])
            # 也保留 desc 差异大（不同 skill）的
            for s, src in all_uniq:
                if s is best[0]:
                    continue
                if text_similarity(s.get('description', ''), best[0].get('description', '')) < 0.5:
                    kept.append(s)

    return kept


def build_match_index(input_path: str, output_path: str):
    """主构建函数。"""
    print(f"[1/6] 读取 {input_path} ...")
    with open(input_path, 'r', encoding='utf-8-sig') as f:
        data = json.load(f)
    skills_raw = data.get('skills', [])
    print(f"  原始: {len(skills_raw)}")

    print("[2/6] 过滤翻译 + 去重 ...")
    skills = [s for s in skills_raw if not is_translation(s.get('file_path', ''))]
    print(f"  过滤翻译: {len(skills)}")
    skills = dedup_skills(skills)
    print(f"  去重: {len(skills)}")

    print("[3/6] 搜索文档 + 分词 ...")
    doc_tokens = []
    doc_lengths = []
    for s in skills:
        name = s.get('name', '').replace('-', ' ').replace('_', ' ')
        desc = s.get('description', '')
        doc_text = f"{name} {name} {name} {desc}"
        tokens = tokenize(doc_text)
        doc_tokens.append(tokens)
        doc_lengths.append(len(tokens))

    avg_dl = sum(doc_lengths) / len(doc_lengths)
    print(f"  平均文档长度: {avg_dl:.1f} tokens")

    print("[4/6] 倒排索引 ...")
    inverted = defaultdict(set)
    for sid, tokens in enumerate(doc_tokens):
        for tok in set(tokens):
            inverted[tok].add(sid)
    inverted = {k: sorted(v) for k, v in inverted.items()}
    print(f"  词汇量: {len(inverted)}")

    print("[5/6] IDF ...")
    N = len(skills)
    idf = {}
    for tok, posting in inverted.items():
        df = len(posting)
        idf[tok] = math.log((N - df + 0.5) / (df + 0.5) + 1.0)

    print("[6/6] 序列化 ...")
    output = {
        "version": datetime.now().isoformat(),
        "total_skills": N,
        "built_at": datetime.now().isoformat(),
        "source_file": str(Path(input_path).name),
        "avg_doc_length": avg_dl,
        "skills": [
            {"name": s['name'], "source": s.get('source', ''),
             "file_path": s.get('file_path', ''),
             "description_preview": s.get('description', '')[:200]}
            for s in skills
        ],
        "name_index": _build_name_index(skills),
        "idf": idf,
        "doc_lengths": doc_lengths,
        "doc_tokens": doc_tokens,
        "inverted": inverted,
    }

    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    size_kb = Path(output_path).stat().st_size / 1024
    print(f"\n输出: {output_path} ({size_kb:.0f} KB, {N} skills, {len(inverted)} terms)")


def _build_name_index(skills: list) -> dict:
    ni = defaultdict(list)
    for i, s in enumerate(skills):
        ni[s['name']].append(i)
    return {k: v for k, v in ni.items()}


if __name__ == "__main__":
    inp = sys.argv[1] if len(sys.argv) > 1 else str(BASE / "skill-index.json")
    out = sys.argv[2] if len(sys.argv) > 2 else str(BASE / "match-index.json")
    build_match_index(inp, out)
