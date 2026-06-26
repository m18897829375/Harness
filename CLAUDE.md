# CLAUDE.md

本文件为 Claude Code 在此仓库中工作时提供指导。

## 项目定位

**harness** 是元项目，编排5个子项目形成AI辅助开发流水线。

- **Agent框架**: Claude Code
- **工作流引擎**: Ralph Harness（PRD驱动的Generator-Evaluator自主开发循环）
- **技能系统**: Claude Skills(422) + ECC(264) + ralph-harness(2) + OpenCLI(6) — 四来源合并去重，694个skill统一索引
- **工具体系**: CLI优先（CLI > MCP），MCP通过OpenCLI转化为CLI

## 工作流

```
用户需求 → 阶段1 Plan(加载skill分析,禁改代码,curl/playwright/Exa搜索,分析完成后按需加载rules) → 阶段2 PRD(ralph-harness生成,生成后等待ralph指令,禁止自动执行) → ⏸️ 等待用户ralph指令 → 阶段3 Ralph Loop(合同协商→Generator(ReAct+Daemon,按需加载skill/CLI)→Evaluator(ReAct+Daemon,按需加载skill/CLI+ECC验证)→通过则完成/未通过回Generator) → 阶段4 最终验证(ECC验证,不通过回阶段1) → 交付
```

### 阶段1收尾：按需加载 Rules

PRD 生成后，根据 `prd.json` 中 `techStack` 字段，从 ECC 子项目 **按需复制** 语言规则到项目 `.claude/rules/ecc/`。

**架构**：
- `~/.claude/rules/ecc/common/` — 全局通用规则，所有项目共用（**用户级，只需配置一次**）
- `subprojects/everything-claude-code/rules/` — 规则源（19 种语言完整副本）
- `.claude/rules/ecc/<language>/` — 按技术栈按需加载（PRD 后自动执行）

> ⚠️ `~/.claude/rules/ecc/` 只需保留 `common/`（用户级），删除所有语言目录可节省数万 tokens/会话。
> **项目级 `.claude/rules/ecc/` 不需要 `common/`**——common 规则从用户目录自动继承，无需重复配置。
> Skills 不需要精简：subprojects 里的 skill 不进入 System Prompt，只在索引表中被搜索。

**按需加载命令**：
```bash
cp -r subprojects/everything-claude-code/rules/<language> .claude/rules/ecc/
```

**技术栈→语言规则映射**：

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

### Ralph Loop 关键步骤

> ⚠️ **PRD 生成后，必须等待用户输入 ralph 指令才能启动 Ralph Loop，禁止自动执行子任务。**

1. **子任务分析**: 先查skill-index.json按需加载skill（辅助发现额外CLI），Claude Code自主判断CLI需求，合并后按需查cli-index.json加载CLI条目。**禁止全量加载索引表**
2. **合同协商**: Generator↔Evaluator协商完成标准，成功锁定执行，失败回Generator重协商
3. **Generator**: ReAct+Daemon模式，按合同实现，调用skill/CLI工具
4. **Evaluator**: ReAct+Daemon模式，按合同验收，调用skill/CLI+ECC测试验证
5. **闭环**: 不通过→回Generator，通过→下一子任务。全部完成→阶段4

## 子项目体系（4个只读 + OpenCLI可写）

| 子项目 | 角色 | 权限 |
|--------|------|:---:|
| `subprojects/claude-skills-main/` | 技能来源1：422个skill | 只读 |
| `subprojects/ralph-harness/` | 工作流引擎 + 技能来源4：2个skill(prd/ralph) | 只读 |
| `subprojects/everything-claude-code/` | 技能来源2+验证工具：264个skill+子任务验证(阶段3)+最终验证(阶段4) | 只读 |
| `subprojects/awesome-mcp-servers/` | MCP服务目录，供OpenCLI转化 | 只读 |
| `subprojects/OpenCLI/` | 技能来源3+MCP→CLI转化(166个适配器) | **可写** |

## 工程约束

### 硬性约束（必须遵守）

1. **Plan模式禁改代码**: 进入Plan模式后，严格禁止修改任何代码。只能讨论、制定计划、使用CLI工具辅助分析、进行网络搜索分析可行性和方案。
2. **PRD生成后等待ralph指令**: PRD 生成后**禁止自动执行子任务**，必须等待用户输入 ralph 指令才能启动 Ralph Loop。阶段2和阶段3之间必须有用户明确的启动指令。
3. **网络搜索**: DeepSeek API 不兼容内置 WebFetch/WebSearch。改用 Exa MCP：
   - `mcp__plugin_ecc_exa__web_search_exa` — 通用网页搜索（首选）。**使用前必须先向用户确认返回条数**
   - `mcp__plugin_ecc_exa__web_fetch_exa` — 抓取网页全文
   - `mcp__github__search_code` / `gh search code` — GitHub 代码搜索
   - `mcp__plugin_context7_context7__query-docs` — 库/框架文档查询
   - 降级备用：`Bash(curl -sL "url")` — 直接抓取已知 URL
   - **搜索必须获取到有效内容，不能收到 0KB 数据就结束。**
4. **CLI优先 > MCP**: 任何工具调用优先使用CLI工具。如只有MCP工具，通过OpenCLI将其转化为CLI工具并全局注册。既有MCP又有CLI时，只保留CLI工具。
5. **禁止降级处理**: 不能靠编写脚本替代使用CLI工具。必须直接调用。
6. **子项目权限**: OpenCLI 可写（用于新增 MCP→CLI 适配器），其余 4 个子项目只读。只读子项目只能通过 `git pull` 同步上游，禁止直接修改。
7. **ReAct + Daemon**: Generator和Evaluator均采用ReAct架构（先思考后调用工具循环），以Daemon模式运行确保中断后执行不中断。
8. **合同协商**: 每个子任务执行前，Generator和Evaluator必须先协商完成标准，协商成功锁定合同后执行，协商失败返回Generator重新协商。严格遵守 ralph-harness 工作流规范。
9. **子任务启动前分析**: 每个PRD子任务执行前，必须按需搜索索引表，只加载当前子任务所需的Skill和CLI条目，禁止全量加载索引表。
10. **索引表查询顺序与原因**: 先按需搜索 Skill索引表 → 加载所需skill作为补充 → 结合Claude Code自主判断 → 按需搜索 CLI索引表 → 加载所需CLI条目 → 最后搜索子项目源码。**先查Skill是因为Skill能辅助发现额外的CLI工具，不是Skill全权决定CLI需求。**
11. **索引表按需渐进加载**: Skill索引表和CLI索引表**禁止一次性全部加载到上下文**。每次只搜索并加载当前子任务所需的条目，像Skill一样渐进式加载。

### 设计原则

- **Skill去重合并**: 四个技能来源（claude-skills-main、ECC、ralph-harness、OpenCLI）可能存在重复skill，由 `scripts/build_skill_index.py` 自动扫描合并去重
- **全局注册**: 通过OpenCLI转化的CLI工具应注册为全局可用
- **索引表动态更新**: 子项目更新后，索引表需同步更新
- **ECC双角色**: ECC同时承担技能提供和测试验证两个角色，覆盖阶段3（子任务验证）和阶段4（最终验证）
- **CLAUDE.md精简策略**: 每次对话Claude Code都会加载完整CLAUDE.md到上下文，因此在harness项目成型后，应删除冗余内容。


## 目录结构

```
harness/
├── CLAUDE.md                    # 本文件
├── cli-index.json               # CLI工具索引(34个工具,按需grep搜索)
├── skill-index.json             # Skill索引(694个skill,四来源去重,按需grep搜索)
├── prds/                        # PRD文档
├── subprojects/                 # 子项目(只读)
│   ├── claude-skills-main/      # 技能来源1(422)
│   ├── ralph-harness/           # 工作流引擎+技能来源4(2)
│   ├── everything-claude-code/  # 技能来源2(264)+验证
│   ├── awesome-mcp-servers/     # MCP目录
│   └── OpenCLI/                 # 技能来源3(6)+MCP→CLI
└── workspace/                   # 工作区
```

## 索引系统

> **按需搜索，禁止全量加载。** 索引表是搜索工具，不是参考资料。

### Skill 匹配（BM25 引擎，推荐）

使用 BM25 倒排索引匹配，分数为连续浮点数（无同分问题），匹配结果 < 2K tokens：

```bash
# 按任务描述匹配（返回 top 5，自动去重）
python3 scripts/match_skills.py "<任务描述>"

# JSON 输出 — Claude Code 解析后加载匹配到的 SKILL.md
python3 scripts/match_skills.py --json --top-k 5 "<描述>"

# 精确 name 查找（O(1) 哈希表）
python3 scripts/match_skills.py --name "react-patterns"

# 重建索引（新增/删除 skill 后）
python3 scripts/match_skills.py --rebuild
```

**调用前查询构造规则**：BM25 对高 IDF 领域专有词（`springboot`、`motion`、`liquid-glass`）敏感，对通用词（`fix`、`button`、`component`）迟钝。调用 match_skills.py 前必须优化查询：

1. **提取技术栈** → 从任务中取框架名、语言名："PayModal.tsx" → 追加 "React TypeScript"
2. **提取领域动作** → 从 AC 提取用户真正在做什么："hide duplicate buttons, show retry" → "state handling user interaction"。不要直接复制 "button" 这种通用词
3. **去除泛化词** → 删除 "fix"、"implement"、"build"、"add" 等（IDF < 2）
4. **优先用 kebab-case 组合词** → "error handling" 优于 "error"（可能命中 error-handling skill name）

**加载规则**：match_skills.py 返回 Top-5（含 name、score、description_preview）。Claude Code 阅读每个 description_preview，自主判断是否加载该 skill 的完整 SKILL.md：

- 描述与任务相关 → 加载
- 描述与任务无关（如 PayModal 查询命中 motion-patterns 动画库）→ 跳过
- 最少加载 1 个
- **原则**：宁可少加载正确 skill，不多加载错误 skill

```

### Skill 索引表 (`skill-index.json`) — 数据源

- 619 个 skill，由 `scripts/build_temp_index.py` 生成
- `build_temp_index.py` 运行后自动触发 `build_match_index.py` 构建 BM25 索引

### CLI 索引表 (`cli-index.json`)

- 34个CLI工具，按13个category分类，每个工具含commands数组

### 旧搜索方式（关键词匹配，备用）

```bash
python3 scripts/search_index.py --type skill --keyword "<英文关键词>"
python3 scripts/search_index.py --type skill --name "<exact-name>"
```

## 使用

启动新任务时：进入Plan模式→加载skill-index.json中需求分析skill→生成PRD→启动Ralph Loop。
