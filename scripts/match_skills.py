"""
BM25 Skill 匹配引擎 CLI。
Claude Code 通过 Bash tool 调用此脚本，接收自然语言任务描述，
返回最相关的 Top-K skill 匹配结果（JSON 或文本格式）。

用法:
    python3 scripts/match_skills.py "implement JWT login in React"
    python3 scripts/match_skills.py --json --top-k 5 "fix memory leak in Python"
    python3 scripts/match_skills.py --name "react-patterns"
    python3 scripts/match_skills.py --rebuild
"""
import argparse, json, math, os, re, sys, subprocess
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
INDEX_PATH = BASE / "match-index.json"
K1 = 1.5
B = 0.75

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


def tokenize(text):
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
    if not INDEX_PATH.exists():
        print("match-index.json 不存在，自动构建...", file=sys.stderr)
        r = subprocess.run(
            [sys.executable, str(BASE / "scripts" / "build_match_index.py")],
            capture_output=True, text=True)
        if r.returncode != 0:
            print(f"构建失败: {r.stderr}", file=sys.stderr)
            sys.exit(1)
        print(r.stdout.strip(), file=sys.stderr)
    with open(INDEX_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def bm25_score(sid, qtoks, idx):
    doc_len = idx['doc_lengths'][sid]
    doc_tokens = idx['doc_tokens'][sid]
    avgdl = idx['avg_doc_length']
    idf = idx['idf']
    score = 0.0
    for qt in qtoks:
        if qt not in idf:
            continue
        tf = sum(1 for t in doc_tokens if t == qt)
        if tf == 0:
            continue
        score += idf[qt] * tf * (K1 + 1) / (tf + K1 * (1 - B + B * doc_len / avgdl))
    return score


def search(query, idx, top_k=5):
    qtoks = tokenize(query)
    if not qtoks:
        return []

    inverted = idx['inverted']
    candidates = set()
    for qt in qtoks:
        if qt in inverted:
            candidates.update(inverted[qt])

    if not candidates:
        for qt in qtoks:
            pref = qt[:4]
            for term, posting in inverted.items():
                if term.startswith(pref):
                    candidates.update(posting)

    if not candidates:
        return []

    scored = [(sid, bm25_score(sid, qtoks, idx)) for sid in candidates if bm25_score(sid, qtoks, idx) > 0]
    scored.sort(key=lambda x: x[1], reverse=True)

    results = []
    seen = set()
    for sid, score in scored:
        skill = idx['skills'][sid]
        name = skill['name']
        if name in seen:
            continue
        seen.add(name)
        results.append({
            "rank": len(results) + 1,
            "name": name,
            "source": skill['source'],
            "score": round(score, 3),
            "file_path": skill['file_path'],
            "description_preview": skill.get('description_preview', '')[:120],
        })
        if len(results) >= top_k:
            break
    return results


def search_by_name(name, idx):
    ni = idx.get('name_index', {})
    if name not in ni:
        print(f"未找到: {name}")
        return []
    results = []
    for sid in ni[name]:
        skill = idx['skills'][sid]
        results.append({
            "rank": len(results) + 1,
            "name": skill['name'],
            "source": skill['source'],
            "score": None,
            "file_path": skill['file_path'],
            "description_preview": skill.get('description_preview', '')[:120],
        })
    return results


def rebuild():
    print("重建 match-index.json ...", file=sys.stderr)
    r = subprocess.run(
        [sys.executable, str(BASE / "scripts" / "build_match_index.py")],
        capture_output=True, text=True)
    print(r.stdout.strip(), file=sys.stderr)
    if r.returncode != 0:
        print(f"构建失败: {r.stderr}", file=sys.stderr)
        sys.exit(r.returncode)


def main():
    p = argparse.ArgumentParser(description="BM25 Skill Matching Engine for Claude Code")
    p.add_argument("query", nargs="?", help="Task description to match skills for")
    p.add_argument("--json", action="store_true", help="Output as JSON")
    p.add_argument("--top-k", type=int, default=5, help="Number of results (default 5)")
    p.add_argument("--name", help="Exact name match")
    p.add_argument("--rebuild", action="store_true", help="Rebuild match-index.json")

    args = p.parse_args()

    if args.rebuild:
        rebuild()
        return

    idx = load_index()

    if args.name:
        results = search_by_name(args.name, idx)
    elif args.query:
        results = search(args.query, idx, args.top_k)
    else:
        print(f"match-index.json: {idx['total_skills']} skills, "
              f"{len(idx['inverted'])} terms, "
              f"built: {idx.get('built_at', 'unknown')}")
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
            "total_skills_in_index": idx['total_skills'],
            "matched_skills": results,
            "tokens_used": len(json.dumps(results, ensure_ascii=False)) // 4,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print(f"{r['rank']:2d}. {r['name']}  (score={r['score']})")
            print(f"    [{r['source']}] {r['file_path']}")
            if r.get('description_preview'):
                print(f"    {r['description_preview']}")
            print()


if __name__ == "__main__":
    main()
