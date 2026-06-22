#!/usr/bin/env python3
"""Build skill-index.json from all subprojects."""
import json, os, re
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent

def extract_frontmatter(filepath):
    """Extract YAML frontmatter from SKILL.md files."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
        if content.startswith('---'):
            end = content.find('---', 3)
            if end > 0:
                fm_text = content[3:end].strip()
                # Simple YAML parser for name/description only
                fm = {}
                for line in fm_text.split('\n'):
                    line = line.strip()
                    if ':' in line:
                        key, _, val = line.partition(':')
                        key = key.strip()
                        val = val.strip().strip('"').strip("'")
                        if key in ('name', 'description', 'origin'):
                            fm[key] = val
                return fm
    except Exception:
        pass
    return {}

def classify_phase(skill_dir, name):
    """Classify skill into development phase."""
    path_lower = str(skill_dir).lower()
    name_lower = (name or '').lower()
    combined = path_lower + ' ' + name_lower

    # Check evaluator FIRST (testing/review patterns often overlap with generator keywords)
    if any(k in combined for k in ['test', 'e2e', 'a11y', 'code-review',
        'security-scan', 'security-review', 'quality', 'silent-failure',
        'type-design', 'pr-test', 'comment-analyzer', 'verification-loop',
        'santa-loop', 'browser-qa', 'ai-regression', 'plankton-code',
        'skill-stocktake', 'skill-health', 'test-coverage', 'quality-gate',
        'prd-verify', 'refactor-clean', 'adversarial', 'linter',
        'code-tour', 'codebase-onboarding']):
        return 'evaluator'
    if any(k in combined for k in ['plan-orchestrate', 'blueprint', 'plan-prd',
        'strategic-compact', 'council', 'project-init', 'model-route',
        'prp-prd', 'multi-plan', 'deep-research', 'brainstorm',
        'code-to-prd', 'product-manager', 'product-strategist',
        'product-discovery', 'product-analytics', 'product-capability',
        'agile-product', 'competitive-teardown', 'research-summarizer',
        'spec-to-repo', 'grill-me', 'grill-with-docs', 'benchmark',
        'benchmark-optimization', 'c-level', 'ceo-advisor', 'cto-advisor',
        'executive-mentor', 'business-growth', 'business-operations',
        'project-management', 'jira-expert']):
        return 'plan'
    if any(k in combined for k in ['verify', 'ship-gate', 'slo', 'release',
        'checkpoint', 'quality-gate', 'production-audit', 'harness-audit',
        'learning', 'evolve', 'learn', 'save-session', 'cost-report',
        'chaos-engineering', 'update-docs', 'update-codemaps',
        'continuous-learning', 'instinct', 'rules-distill', 'gateguard',
        'security-bounty', 'prune']):
        return 'verify'
    if any(k in combined for k in ['prd-verify-impl', 'ralph-json']):
        return 'prd'
    return 'generator'

def classify_category(skill_dir, name):
    """Classify into category."""
    path_lower = str(skill_dir).lower()
    name_lower = (name or '').lower()
    combined = path_lower + ' ' + name_lower

    # High-specificity checks first
    if any(k in combined for k in ['healthcare', 'clinical', 'phi',
        'medical', 'cdss', 'emr']):
        return 'healthcare'
    if any(k in combined for k in ['compliance', 'iso-', 'fda-', 'gdpr',
        'soc2', 'regulatory', 'ra-qm', 'mdr-', 'capa-', 'qms-', 'isms-']):
        return 'compliance'
    if any(k in combined for k in ['marketing', 'seo', 'content-engine',
        'content-product', 'content-strateg', 'content-human', 'brand-',
        'campaign', 'social-', 'growth-marketer', 'email-sequence',
        'email-template', 'copywriting', 'copy-editing', 'landing-page',
        'paid-ads', 'demand-gen', 'aso-', 'aeo-', 'schema-markup',
        'programmatic-seo', 'site-architecture', 'page-cro', 'popup-cro',
        'form-cro', 'signup-flow', 'onboarding-cro', 'paywall-upgrade',
        'cold-email', 'referral-program', 'pricing-strategy', 'launch-strategy',
        'free-tool-strategy', 'competitive-intel', 'competitive-matrix',
        'competitive-teardown', 'competitor-alternatives', 'marketing-ops',
        'marketing-context', 'marketing-ideas', 'marketing-psychology',
        'market-research', 'sales-engineer', 'demo-video', 'rfp-responder',
        'crosspost', 'social-publisher', 'social-graph-ranker',
        'lead-intelligence', 'investor-materials', 'investor-outreach',
        'article-writing', 'video-editing', 'remotion-video',
        'manim-video']):
        return 'marketing'
    if any(k in combined for k in ['finance-billing', 'business-investment',
        'saas-metrics-coach', 'financial-analyst',
        'deal-desk', 'pricing-strategist', 'channel-economics',
        'commercial-policy', 'commercial-forecaster', 'commercial-skills',
        'cfo-advisor', 'revenue-operations', 'customer-billing',
        'defi-amm', 'evm-token', 'prediction-market', 'llm-trading',
        'ito-basket', 'ito-data-atlas', 'ito-market', 'ito-trade',
        'cost-aware-llm', 'cost-tracking', 'cost-report',
        'token-budget', 'context-budget']):
        return 'finance'
    if any(k in combined for k in ['security', 'pen-test', 'adversarial-review',
        'threat-detection', 'incident-response', 'gateguard',
        'database-protection', 'red-team', 'safety-guard', 'hookify-rules',
        'cloud-security', 'ai-security', 'security-bounty',
        'secrets-detection', 'owasp']):
        return 'security'
    if any(k in combined for k in ['performance', 'optimizer',
        'benchmark-optimization', 'latency-critical', 'data-throughput',
        'parallel-execution-optimizer', 'connections-optimizer']):
        return 'performance'
    if any(k in combined for k in ['database', 'postgres', 'sql', 'prisma',
        'redis', 'mysql', 'clickhouse', 'database-migration',
        'snowflake-development', 'database-designer', 'database-schema']):
        return 'database'
    if any(k in combined for k in ['deploy', 'docker-', 'kubernetes',
        'ci-cd', 'pm2', 'devops', 'ship-gate', 'helm-chart', 'terraform',
        'vite-proxy', 'dev-server-listen', 'release-manager',
        'flox-environments', 'uncloud', 'deployment-patterns']):
        return 'deployment'
    if any(k in combined for k in ['test', 'tdd', 'e2e', 'a11y', 'code-review',
        'evaluat', 'qa-', 'debug', 'bug', 'quality', 'silent-failure',
        'type-design', 'pr-test', 'comment-analyzer', 'verification-loop',
        'santa-loop', 'refactor-clean', 'adversarial', 'browser-qa',
        'code-tour', 'codebase-onboarding', 'security-scan', 'security-review',
        'ai-regression', 'plankton-code', 'skill-stocktake', 'skill-health',
        'test-coverage', 'quality-gate', 'prd-verify']):
        return 'testing'
    if any(k in combined for k in ['product-team', 'product-manager',
        'product-strategist', 'product-discovery', 'product-analytics',
        'product-lens', 'product-capability', 'agile-product',
        'ux-research', 'code-to-prd', 'spec-to-repo', 'saas-scaffolder',
        'competitive-teardown', 'roadmap-communicator', 'experiment-designer',
        'research-summarizer']):
        return 'requirements'
    if any(k in combined for k in ['c-level', 'ceo-advisor', 'cto-advisor',
        'coo-advisor', 'cpo-advisor', 'cmo-advisor', 'cro-advisor',
        'ciso-advisor', 'chro-advisor', 'general-counsel', 'vpe-advisor',
        'chief-ai', 'chief-customer', 'chief-data', 'executive-mentor',
        'founder-mode', 'c-suite', 'boardroom', 'office-hours',
        'business-growth', 'business-operations', 'commercial-',
        'process-mapper', 'vendor-management', 'capacity-planner',
        'internal-comms', 'knowledge-ops', 'procurement-optimizer',
        'project-management', 'senior-pm', 'scrum-master', 'jira-expert',
        'confluence-expert', 'atlassian', 'customer-success-manager']):
        return 'management'
    if any(k in combined for k in ['plan', 'brainstorm', 'strategy',
        'deep-research', 'research-ops', 'research-summarizer',
        'grill-me', 'grill-with-docs', 'multi-plan', 'strategic-compact',
        'council', 'project-init', 'model-route', 'prp-prd',
        'plan-orchestrate', 'blueprint']):
        return 'requirements'
    return 'development'

def scan_source(source_name, skills_dir):
    """Scan a source directory for SKILL.md files."""
    results = []
    skills_path = Path(skills_dir)
    if not skills_path.exists():
        print(f"  WARNING: {skills_dir} does not exist")
        return results

    count = 0
    for sk_md in skills_path.rglob('SKILL.md'):
        fm = extract_frontmatter(sk_md)
        name = fm.get('name', sk_md.parent.name)
        description = fm.get('description', '')
        if not name:
            continue

        # Extract keywords from name
        keywords = name.replace('-', ' ').split()[:8]

        # Use absolute path — works from any directory (including workspace/)
        abs_path = str(sk_md.resolve())

        results.append({
            'name': name,
            'source': source_name,
            'category': classify_category(sk_md.parent, name),
            'phase': classify_phase(sk_md.parent, name),
            'description': description[:250] if description else f'{name}',
            'trigger_keywords': keywords,
            'file_path': abs_path
        })
        count += 1

    print(f"  Found {count} skills")
    return results

# Scan all three sources
print("Scanning subprojects for SKILL.md files...")

print("\n[1/3] claude-skills-main...")
cs_skills = scan_source('claude-skills-main',
    BASE / 'subprojects' / 'claude-skills-main')

print("\n[2/3] everything-claude-code...")
ecc_skills = scan_source('everything-claude-code',
    BASE / 'subprojects' / 'everything-claude-code')

print("\n[3/4] OpenCLI...")
opencli_skills = scan_source('OpenCLI',
    BASE / 'subprojects' / 'OpenCLI' / '.agents' / 'skills')

print("\n[4/4] ralph-harness...")
ralph_skills = scan_source('ralph-harness',
    BASE / 'subprojects' / 'ralph-harness' / 'skills')

all_skills = cs_skills + ecc_skills + opencli_skills + ralph_skills

# Deduplicate by source+name (same name from different sources = different skills)
seen = set()
deduped = []
dupes = 0
for s in all_skills:
    key = f"{s['source']}:{s['name']}"
    if key not in seen:
        seen.add(key)
        deduped.append(s)
    else:
        dupes += 1

print(f"\nTotal: {len(all_skills)} found, {dupes} same-source duplicates removed, {len(deduped)} unique")

# Build index
index = {
    '$schema': 'skill-index.schema.json',
    'description': 'Skill索引表——Claude Skills + ECC + OpenCLI 三来源合并去重。按需搜索(grep)，禁止全量加载。先查此表再查CLI索引表。',
    'last_updated': '2026-06-10',
    'total_skills': len(deduped),
    'by_source': {
        'claude-skills-main': len([s for s in deduped if s['source'] == 'claude-skills-main']),
        'everything-claude-code': len([s for s in deduped if s['source'] == 'everything-claude-code']),
        'OpenCLI': len([s for s in deduped if s['source'] == 'OpenCLI']),
        'ralph-harness': len([s for s in deduped if s['source'] == 'ralph-harness'])
    },
    'categories': {
        '需求分析': 'Plan和PRD阶段的技能',
        '开发': 'Generator阶段的实现技能',
        '测试': 'Evaluator阶段的验证技能',
        '部署': '发布部署相关技能',
        '安全': '安全审查和防护技能',
        '性能': '性能分析和优化技能',
        '数据库': '数据库设计和迁移技能',
        '管理': '企业管理和商业运营技能',
        '营销': '市场营销相关技能',
        '金融': '金融分析相关技能',
        '合规': '合规和法规相关技能',
        '医疗': '医疗健康相关技能'
    },
    'phases': {
        'plan': '需求分析阶段——讨论、规划、研究',
        'prd': 'PRD生成阶段——生成结构化需求文档',
        'generator': '代码生成阶段——按合同实现功能',
        'evaluator': '代码验证阶段——按合同验收功能',
        'verify': '最终验证阶段——整体项目完整性检查'
    },
    'skills': sorted(deduped, key=lambda x: (x['category'], x['name']))
}

output_path = BASE / 'skill-index.json'
with open(output_path, 'w', encoding='utf-8') as f:
    json.dump(index, f, ensure_ascii=False, indent=2)

# Stats
cats = {}
phases = {}
for s in deduped:
    cats[s['category']] = cats.get(s['category'], 0) + 1
    phases[s['phase']] = phases.get(s['phase'], 0) + 1

print(f"\nBy category:")
for c, n in sorted(cats.items(), key=lambda x: -x[1]):
    print(f"  {c}: {n}")
print(f"\nBy phase:")
for p, n in sorted(phases.items(), key=lambda x: -x[1]):
    print(f"  {p}: {n}")

print(f"\nWritten to: {output_path}")
