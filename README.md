# harness

以LLM为马，以项目目标为跑道，harness 为LLM提供全套"马具"——工作流、工具索引、技能系统——让AI驱动开发跑得更快更稳。

## 核心理念

harness 不直接产出代码，编排5个专业化子项目，形成从需求分析到交付验证的完整AI开发流水线：

| 阶段 | 工具 | 产出 |
|------|------|------|
| 需求分析 | Plan模式 + Skill索引表（三来源：Claude Skills + ECC + OpenCLI） | 需求分析文档 |
| PRD生成 | Ralph Harness | 结构化PRD（含优先级） |
| 自主开发 | Ralph Loop：合同协商 → Generator → Evaluator | 子任务逐个完成 |
| 交付验证 | ECC 工具集（子任务验证 + 最终验证） | 验证报告 |

## 工程原则

- **Plan模式禁改代码**: 只讨论分析，不写代码；网络搜索必须获取有效内容，禁止0KB结束
- **Skill按需加载**: 先查Skill索引表 → 再查CLI索引表，禁止全量加载索引表
- **CLI优先**: CLI工具 > MCP工具，MCP通过OpenCLI转化为CLI
- **ReAct + Daemon**: Generator和Evaluator均采用思考-行动循环，daemon守护防中断
- **合同协商**: 每个子任务执行前Generator和Evaluator先协商完成标准
- **子项目只读**: 仅通过git同步，不直接修改
- **Skill三来源去重**: Claude Skills + ECC + OpenCLI，合并冗余

## 子项目体系

```
subprojects/
├── claude-skills-main/      # 技能来源1: 343个skill(757个SKILL.md)
├── ralph-harness/           # 工作流引擎: PRD生成+Ralph Loop(含合同协商)
├── everything-claude-code/  # 技能来源2+验证: 261个skill+子任务+最终验证
├── awesome-mcp-servers/     # MCP服务目录，供OpenCLI查找和转化
└── OpenCLI/                 # 技能来源3+MCP→CLI转化(166个适配器)
```

## 各子项目适配 Claude Code

### 1. claude-skills-main — 技能库

757个 SKILL.md 文件按领域分布在子项目目录中。**不需要安装到全局 `~/.claude/skills/`**，通过 `skill-index.json` 按需加载。

**适配方式：** 技能文件留在子项目内，由 Claude Code 在开发过程中根据当前子任务需求，搜索 `skill-index.json` 找到对应的 `file_path`，直接从子项目路径加载 SKILL.md。

### 2. ralph-harness — 工作流引擎

Ralph 是纯 Bash 编排层，驱动 Claude Code 作为 Generator 和 Evaluator。

**前置依赖：**
```bash
# jq — JSON处理
# curl — MCP健康检查
# Node.js >= 18 — MCP工具运行时
# Claude Code — AI引擎 (npm install -g @anthropic-ai/claude-code)

# 安装 Playwright 浏览器（Evaluator E2E测试必需）
npx playwright install chromium
```

**适配方式：** 配置 `.mcp.json` 启用 Playwright MCP（HTTP模式避免Windows MSYS2管道死锁）。Ralph 自动管理 MCP 服务器生命周期。其 `.claude-plugin/` 目录提供 `ralph-skills` 插件（`ralph`、`ralph-run`、`ralph-nav`、`ralph-bug`、`ralph-dev`、`ralph-loop` 等 skill）。

### 3. everything-claude-code (ECC) — 技能+验证工具集

ECC 通过自身安装器适配 Claude Code，**不能叠加多种安装方式**。

**适配方式（二选一）：**

**方式A — 最小化安装（推荐）：**
```bash
cd subprojects/everything-claude-code
npm install
node scripts/install-apply.js --profile minimal --target claude
```
安装 368 个文件到 `~/.claude/`：19 个语言规则 + 21 个核心 skill + agents + commands。不包含 Hook 运行时（减少上下文占用）。

**方式B — 完整安装：**
```bash
cd subprojects/everything-claude-code
npm install
./install.sh --profile full --target claude   # Linux/Mac
# 或 .\install.ps1 --profile full --target claude  # Windows
```
安装全部 23 个模块。

**安装后**，ECC 的 rules/agents/skills/commands 位于 `~/.claude/` 对应目录，Claude Code 自动发现。可通过 `npx ecc consult <query>` 查询匹配的组件。

### 4. awesome-mcp-servers — MCP服务目录

纯参考目录，无需任何安装。包含 800KB+ 的 MCP 服务器列表，按分类组织。

**适配方式：** 当 Generator 或 Evaluator 需要调用某 MCP 服务时，先在此目录搜索是否已有可用实现，如有则通过 OpenCLI 将其转化为 CLI 工具并全局注册。

### 5. OpenCLI — MCP→CLI转化工具

**适配方式：**
```bash
cd subprojects/OpenCLI
npm install        # 安装依赖并自动构建(生成cli-manifest.json, 1046条)
npm link           # 全局注册 opencli 命令

# 验证
opencli --version  # 应输出 1.8.2
opencli list       # 列出所有166个可用适配器
```

**Playwright CLI（首选浏览器自动化）：**
```bash
npx playwright install chromium
opencli playwright navigate <url>
opencli playwright snapshot
opencli playwright screenshot <url> <output.png>
```

OpenCLI 的 6 个 skill（`opencli-browser`、`opencli-adapter-author`、`opencli-autofix` 等）位于 `subprojects/OpenCLI/.agents/skills/`，通过 `skill-index.json` 按需加载。

**重要：** 禁止编写 `.js`/`.py`/`.sh` 脚本调用 Playwright，必须直接使用 `opencli playwright` CLI 命令。CLI 失效时可用 MCP 工具作为备选。

---

## 快速开始

```bash
# 1. 克隆仓库（含子模块）
git clone --recurse-submodules https://github.com/m18897829375/Harness.git
cd Harness

# 2. 适配 ECC（最小化安装）
cd subprojects/everything-claude-code && npm install && node scripts/install-apply.js --profile minimal --target claude && cd ../..

# 3. 注册 OpenCLI 全局命令
cd subprojects/OpenCLI && npm install && npm link && cd ../..

# 4. 安装 Playwright 浏览器（ralph-harness 和 OpenCLI 共用）
npx playwright install chromium

# 5. 验证
opencli --version      # OpenCLI: 1.8.2
bash subprojects/ralph-harness/ralph.sh --help  # Ralph 可用
```

详细工作流和工程约束见 [CLAUDE.md](CLAUDE.md)。

## Rules 按需加载系统

ECC rules 按技术栈按需加载，避免无关规则占用上下文。

### 架构

```
~/.claude/rules/ecc/common/       ← 全局通用规则（只保留 common）
subprojects/everything-claude-code/rules/ ← 规则源（19 种语言）
.claude/rules/ecc/<language>/     ← 按需加载（PRD 后自动执行）
```

### 工作流

```
PRD 生成 → 分析 techStack → 从 ECC 子项目复制语言规则到项目
```

### 命令

```bash
cp -r subprojects/everything-claude-code/rules/<language> .claude/rules/ecc/
```

### 技术栈→语言规则映射

| PRD 技术栈关键词 | 需要的 rules 目录 |
|------|------|
| React, Next.js, Vue, Vite | web, typescript, react |
| Python, Django, FastAPI, Flask | python |
| Go, Golang | golang |
| Rust, Cargo | rust |
| Java, Spring, Maven, Gradle | java |
| Kotlin, KMP | kotlin |
| Swift, iOS, Xcode | swift |
| Dart, Flutter | dart |
| C++, CMake | cpp |
| .NET, C#, ASP.NET | csharp |
| PHP, Laravel | php |
| Ruby, Rails | ruby |
| Angular | angular, typescript, web |
| HarmonyOS, ArkTS | arkts |
| Node.js, Express | typescript |
| React Native, Expo | react, typescript |

> **重要**：`~/.claude/rules/ecc/` 只保留 `common/`，删除所有语言目录可节省数万 tokens/会话。
