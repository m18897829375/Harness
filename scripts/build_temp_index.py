"""Scan all 5 subprojects and generate skill-index.json"""
import json, re
from pathlib import Path
from collections import defaultdict

BASE = Path(__file__).resolve().parent.parent
SUBPROJECTS = [
    ("claude-skills-main",    BASE / "subprojects/claude-skills-main"),
    ("everything-claude-code", BASE / "subprojects/everything-claude-code"),
    ("OpenCLI",               BASE / "subprojects/OpenCLI"),
    ("ralph-harness",         BASE / "subprojects/ralph-harness"),
    ("awesome-mcp-servers",   BASE / "subprojects/awesome-mcp-servers"),
]


def classify_category(name, desc, keywords):
    combined = f"{name} {desc} {' '.join(keywords)}".lower()
    if any(k in combined for k in ['test', 'tdd', 'e2e', 'code-review', 'evaluat',
        'qa-', 'debug', 'bug', 'quality', 'silent-failure', 'type-design',
        'pr-test', 'comment-analyzer', 'verification-loop', 'santa-loop',
        'refactor-clean', 'browser-qa', 'security-scan', 'security-review',
        'ai-regression', 'plankton-code', 'skill-stocktake', 'skill-health',
        'test-coverage', 'quality-gate', 'prd-verify', 'code-tour',
        'codebase-onboarding']):
        return 'testing'
    if any(k in combined for k in ['deploy', 'docker-', 'kubernetes', 'ci-cd',
        'pm2', 'devops', 'helm-chart', 'terraform', 'uncloud',
        'deployment-patterns', 'dev-server-listen', 'flox-environments']):
        return 'deployment'
    if any(k in combined for k in ['security', 'vulnerability', 'hipaa',
        'gdpr', 'audit', 'iso', 'soc2', 'pci', 'phi', 'aims-audit',
        'ai-security', 'cloud-security', 'compliance']):
        return 'security'
    if any(k in combined for k in ['performance', 'optimizer', 'benchmark',
        'latency-critical', 'data-throughput', 'parallel-execution']):
        return 'performance'
    if any(k in combined for k in ['database', 'postgres', 'sql', 'prisma',
        'redis', 'mysql', 'clickhouse', 'database-migration']):
        return 'database'
    if any(k in combined for k in ['marketing', 'seo', 'ad-', 'campaign',
        'social-', 'content-', 'brand-', 'copy', 'email-', 'webinar',
        'market-research', 'marketing-campaign']):
        return 'marketing'
    if any(k in combined for k in ['finance', 'billing', 'invoice', 'payment',
        'tax', 'accounting', 'investor', 'trading', 'procurement']):
        return 'finance'
    if any(k in combined for k in ['compliance', 'iso', 'gdpr', 'fda', 'soc',
        'hipaa', 'regulatory', 'legal', 'customs', 'trade']):
        return 'compliance'
    if any(k in combined for k in ['healthcare', 'medical', 'clinical', 'cdss',
        'emr', 'ehr', 'patient', 'phi']):
        return 'healthcare'
    if any(k in combined for k in ['c-level', 'ceo', 'cto', 'cfo', 'cmo', 'coo',
        'senior-pm', 'scrum', 'jira', 'confluence', 'atlassian', 'business-',
        'vendor', 'capacity', 'internal-comms', 'knowledge-ops',
        'process-mapper', 'project-management', 'chief-ai', 'founder-mode',
        'executive-mentor']):
        return 'management'
    if any(k in combined for k in ['plan', 'brainstorm', 'strategy',
        'deep-research', 'research-ops', 'research-summarizer', 'multi-plan',
        'strategic-compact', 'council', 'project-init', 'model-route',
        'prp-prd', 'plan-orchestrate', 'blueprint', 'product-', 'prd',
        'requirements']):
        return 'requirements'
    return 'development'


def classify_phase(name, desc):
    combined = f"{name} {desc}".lower()
    if any(k in combined for k in ['plan', 'prd', 'brainstorm', 'strategy',
        'research', 'requirements', 'blueprint', 'spec']):
        if not any(k in combined for k in ['generator', 'build', 'implement']):
            return 'plan'
    if any(k in combined for k in ['verify', 'validation', 'checkpoint',
        'final', 'acceptance']):
        return 'verify'
    if any(k in combined for k in ['evaluat', 'test', 'review', 'verify',
        'audit', 'qa', 'check', 'score', 'judge', 'code-review']):
        return 'evaluator'
    return 'generator'


BLOCK_SCALARS = {'|', '|-', '|+', '>', '>-', '>+'}

def extract_fm(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8-sig', errors='ignore') as f:
            content = f.read(5000)
        if not content.startswith('---'):
            return None
        end = content.find('\n---', 3)
        if end < 0:
            return None
        fm_text = content[4:end]  # skip opening '---\n'

        name = ''
        desc = ''
        in_desc_block = False
        desc_lines = []

        for line in fm_text.split('\n'):
            if in_desc_block:
                # Collect indented continuation lines for block scalar
                if line and (line[0] == ' ' or line[0] == '\t'):
                    desc_lines.append(line.strip())
                else:
                    in_desc_block = False
                    if desc_lines:
                        desc = ' '.join(desc_lines)
                    desc_lines = []
                if in_desc_block:
                    continue

            m = re.match(r'^description:\s*(.+)$', line)
            if m:
                val = m.group(1).strip()
                if val in BLOCK_SCALARS:
                    in_desc_block = True
                    desc_lines = []
                else:
                    desc = val.strip('"')
                continue

            m = re.match(r'^name:\s*(.+)$', line)
            if m:
                name = m.group(1).strip().strip('"')

        # Catch desc block at end of frontmatter
        if in_desc_block and desc_lines:
            desc = ' '.join(desc_lines)

        if not name:
            return None

        return {'name': name, 'description': desc, 'keywords': []}
    except Exception:
        return None


def main():
    all_skills = []
    source_stats = defaultdict(int)

    for src_name, src_path in SUBPROJECTS:
        if not src_path.exists():
            print(f"[SKIP] {src_name}: not found")
            continue
        count = 0
        for sk_md in src_path.rglob("SKILL.md"):
            if any(p.startswith('.') or p == 'node_modules' for p in sk_md.parts):
                continue
            fm = extract_fm(sk_md)
            if not fm or not fm['name']:
                continue
            # Exclude ralph-harness built-in skills (managed by ralph.sh directly)
            if fm['name'] in ('prd', 'ralph', 'research'):
                continue
            cat = classify_category(fm['name'], fm['description'], fm['keywords'])
            ph = classify_phase(fm['name'], fm['description'])
            all_skills.append(dict(
                name=fm['name'], source=src_name, category=cat, phase=ph,
                description=fm['description'], trigger_keywords=fm['keywords'],
                file_path=str(sk_md.relative_to(BASE)),
            ))
            count += 1
        source_stats[src_name] = count
        print(f"  {src_name}: {count} skills")

    # No dedup — keep all skills from all sources
    print(f"\nTotal: {len(all_skills)} skills (no dedup)")

    cat_stats = defaultdict(int)
    for s in all_skills:
        cat_stats[s['category']] += 1
    print("By category:")
    for c, n in sorted(cat_stats.items(), key=lambda x: -x[1]):
        print(f"  {c}: {n}")

    output = dict(
        description="Skill index - 5 subprojects full scan (no dedup)",
        total_skills=len(all_skills),
        sources=dict(source_stats),
        skills=all_skills,
    )
    out_path = BASE / "skill-index.json"
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"\nWritten: {out_path} ({out_path.stat().st_size / 1024:.0f} KB)")

    # Auto-build match-index.json
    import subprocess, sys
    print("\nBuilding match-index.json...")
    r = subprocess.run(
        [sys.executable, str(BASE / "scripts" / "build_match_index.py")],
        capture_output=True, text=True
    )
    if r.returncode != 0:
        print(f"WARNING: {r.stderr}")
    else:
        print(r.stdout.strip())

    # Auto-build cli-match-index.json
    print("\nBuilding cli-match-index.json...")
    r = subprocess.run(
        [sys.executable, str(BASE / "scripts" / "build_cli_match_index.py")],
        capture_output=True, text=True
    )
    if r.returncode != 0:
        print(f"WARNING: {r.stderr}")
    else:
        print(r.stdout.strip())


if __name__ == "__main__":
    main()
