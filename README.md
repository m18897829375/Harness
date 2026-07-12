# Harness

AI 辅助开发流水线引擎——编排 5 个子项目，形成从需求分析到交付验证的完整开发闭环。

- **Agent 框架**: Claude Code
- **工作流引擎**: Ralph Harness（PRD 驱动的 Generator-Evaluator 自主开发循环）
- **技能系统**: BM25 搜索引擎，617 skill（三来源合并去重）
- **工具体系**: CLI 优先（CLI > MCP），MCP 通过 OpenCLI 转化为 CLI

## 工作流

```
用户需求 → Plan(research) → PRD → Ralph Loop(合同协商→Generator→Evaluator) → 最终验证 → 交付
```

## 子项目体系

```
subprojects/
├── claude-skills-main/      # 技能来源1: 348 skill
├── ralph-harness/           # 工作流引擎: PRD生成 + Ralph Loop(合同协商)
├── everything-claude-code/  # 技能来源2 + 验证: 261 skill + 代码审查/测试/验证工具
├── awesome-mcp-servers/     # MCP 服务目录，供 OpenCLI 查找和转化
└── OpenCLI/                 # 技能来源3 + MCP→CLI 转化(1049 CLI命令, 含17个已转化MCP)
```

5 个子项目均为 git submodule，**只读**——仅通过 `git pull` 同步上游。`OpenCLI` 可写（用于新增 MCP→CLI 适配器）。

## Skill & CLI 发现引擎

项目内置 BM25 倒排索引搜索引擎，按需加载——**禁止将全量索引表加载到上下文**。

### Skill 匹配（BM25，604 skill 去重后）

```bash
python3 scripts/match_skills.py --json --top-k 5 "React form validation"   # BM25 排名
python3 scripts/match_skills.py --name "playwright-cli"                    # 精确查找
```

### CLI 匹配（三源统一：native + OpenCLI + MCP，3459 条目）

```bash
python3 scripts/match_cli.py --json --top-k 3 "browser automation"          # 基本搜索
python3 scripts/match_cli.py --source mcp "postgresql query"                # 只看 MCP
python3 scripts/match_cli.py --source native,opencli "version control"      # 只看已有 CLI
python3 scripts/match_cli.py --name "opencli xiaohongshu download"          # 精确查找
python3 scripts/match_cli.py --list --category api-client                   # 按分类浏览
```

**结果标记**：`[CLI]` 原生 / `[OpenCLI]` 已转化 / `[MCP→CLI] [待转化]`（分数降权 ×0.7）

**查询顺序**：先 Skill → 再 CLI → 最后源码。先查 Skill 是因为 Skill 能辅助发现额外的 CLI 工具。

### 索引重建

```bash
python3 scripts/build_temp_index.py    # 重新扫描子项目 + 重建 skill + CLI BM25 索引
```

## PRD 后工具预检

Ralph Loop 的 Generator/Evaluator 无法自行登录或安装工具。PRD 生成后须提醒用户：

```bash
python3 scripts/match_cli.py --preflight
```

输出两类工具：
- **需要登录**：OpenCLI 站点适配器（cookie/ui 策略），需在 Chrome 中先登录
- **需要安装**：`mcp_install_cmd` 不为空的 MCP 工具

## 目录结构

```
harness/
├── CLAUDE.md                 # 项目完整文档（工作流细节、工程约束）
├── README.md                 # 项目概述（本文件）
├── skill-index.json          # Skill 索引（617 skill）
├── match-index.json          # Skill BM25 倒排索引（604 skill 去重后）
├── cli-match-index.json      # CLI BM25 倒排索引（3459 条目，三源统一）
├── workspace/                # 所有生成代码的输出目录（gitignore）
├── scripts/                  # 索引构建 + 搜索 + 调用记录（9 个工具脚本）
├── .ralph/                   # Ralph 运行时数据（tool-calls / cli-calls / search-results）
├── prds/                     # PRD 文档存放
└── subprojects/              # 5 个 git submodule（只读）
```

## 各子项目适配 Claude Code

### 1. claude-skills-main — 技能库

348 skill 按领域分布，**不需要安装到全局 `~/.claude/skills/`**。通过 BM25 搜索引擎（`match_skills.py`）按需加载——从 `skill-index.json` 找到 `file_path`，直接加载 SKILL.md。

### 2. ralph-harness — 工作流引擎

纯 Bash 编排层，驱动 Claude Code 作为 Generator 和 Evaluator。

**前置依赖：**
```bash
# jq — JSON 处理
# curl — 网络请求
# Node.js >= 18 — MCP 工具运行时
# Claude Code — AI 引擎 (npm install -g @anthropic-ai/claude-code)

# 安装 Playwright 浏览器（Evaluator E2E 测试必需）
npx playwright install chromium
```

ralph-harness 的 `.claude-plugin/` 目录提供 `ralph-skills` 插件（`ralph`、`ralph-run`、`ralph-nav`、`ralph-bug`、`ralph-dev` 等 skill）。

### 3. everything-claude-code (ECC) — 技能 + 验证工具集

ECC 的 261 个 skill 已全部索引在 `skill-index.json` 中，通过 BM25 按需加载——**不需要安装到全局**。

仅以下 skill 和 rules 需要手动复制到 `~/.claude/`，确保始终可用（由描述触发）：

**适配方式：**
```bash
cd subprojects/everything-claude-code
npm install   # 测试脚本等依赖
cd ../..

# Rules — 复制通用规则
mkdir -p ~/.claude/rules/ecc/common
cp -r subprojects/everything-claude-code/rules/common/* ~/.claude/rules/ecc/common/

# Skills — 复制 ECC 核心 skill（21 个）
mkdir -p ~/.claude/skills/ecc
for skill in agent-introspection-debugging agent-sort ai-regression-testing \
  code-tour configure-ecc continuous-learning continuous-learning-v2 \
  council e2e-testing error-handling eval-harness hookify-rules \
  iterative-retrieval plankton-code-quality production-audit \
  skill-scout skill-stocktake strategic-compact tdd-workflow \
  verification-loop windows-desktop-e2e; do
  cp -r subprojects/everything-claude-code/skills/$skill ~/.claude/skills/ecc/
done
```

> **说明**：这 21 个 skill 放在 `~/.claude/skills/ecc/` 下使其始终可用（由 skill 描述字段自动触发）。其余 240 个 ECC skill 通过 `match_skills.py` 从 subprojects 按需加载。

### 4. awesome-mcp-servers — MCP 服务目录

纯参考目录，包含 2282 个 MCP 服务器（按 50+ 分类组织），索引已并入 `cli-match-index.json`。

**适配方式**：当需要某 MCP 服务时，通过 `match_cli.py --source mcp` 搜索，找到后通过 OpenCLI 将其转化为 CLI 工具并全局注册。

### 5. OpenCLI — MCP→CLI 转化工具

```bash
cd subprojects/OpenCLI
npm install        # 安装依赖并自动构建
npm link           # 全局注册 opencli 命令

# 验证
opencli --version
opencli list       # 列出所有可用适配器
```

**Playwright CLI（首选浏览器自动化）：**
```bash
opencli playwright navigate <url>
opencli playwright snapshot
opencli playwright screenshot <url> <output.png>
```

**重要**：禁止编写脚本调用 Playwright，必须直接使用 `opencli playwright` CLI 命令。

---

## 快速开始

```bash
# 1. 克隆仓库（含子模块）
git clone --recurse-submodules https://github.com/m18897829375/Harness.git
cd Harness

# 2. 构建索引表
python3 scripts/build_temp_index.py

# 3. 验证搜索
python3 scripts/match_skills.py --json --top-k 1 "test"
python3 scripts/match_cli.py --json --top-k 1 "test"

# 4. 适配 ECC（复制 rules + 核心 skill）
cd subprojects/everything-claude-code && npm install && cd ../..
mkdir -p ~/.claude/rules/ecc/common
cp -r subprojects/everything-claude-code/rules/common/* ~/.claude/rules/ecc/common/
mkdir -p ~/.claude/skills/ecc
for skill in agent-introspection-debugging agent-sort ai-regression-testing code-tour configure-ecc continuous-learning continuous-learning-v2 council e2e-testing error-handling eval-harness hookify-rules iterative-retrieval plankton-code-quality production-audit skill-scout skill-stocktake strategic-compact tdd-workflow verification-loop windows-desktop-e2e; do cp -r subprojects/everything-claude-code/skills/$skill ~/.claude/skills/ecc/; done

# 5. 注册 OpenCLI 全局命令
cd subprojects/OpenCLI && npm install && npm link && cd ../..

# 6. 安装 Playwright 浏览器
npx playwright install chromium

# 7. PRD 预检（生成 PRD 后执行）
python3 scripts/match_cli.py --preflight
```

详细工作流和工程约束见 [CLAUDE.md](CLAUDE.md)。
