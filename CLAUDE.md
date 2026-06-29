# CLAUDE.md

本文件为 Claude Code 在此仓库中工作时提供指导。

## 项目定位

**harness** 是元项目，编排5个子项目形成AI辅助开发流水线。

- **Agent框架**: Claude Code
- **工作流引擎**: Ralph Harness（PRD驱动的Generator-Evaluator自主开发循环）
- **技能系统**: 5个子项目合并索引，619个skill统一索引表（BM25按需搜索）
- **工具体系**: CLI优先（CLI > MCP），MCP通过OpenCLI转化为CLI

## 工作流

```
用户需求 → 阶段1 Plan(加载skill分析,禁改代码,Exa/curl搜索) → 阶段2 PRD(ralph生成,生成后等待ralph指令) → ⏸️ 等待ralph指令 → 阶段3 Ralph Loop(合同协商→Generator(ReAct+Daemon)→Evaluator(ReAct+Daemon)→通过则完成/未通过回Generator) → 阶段4 最终验证(ECC验证,不通过回阶段1) → 交付
```

### 阶段1收尾：按需加载 Rules

PRD 生成后，根据 `prd.json` 中 `techStack` 字段，从 ECC 子项目按需复制语言规则到项目 `.claude/rules/ecc/`。

> ⚠️ `~/.claude/rules/ecc/` 只需保留 `common/`（用户级）。**项目级 `.claude/rules/ecc/` 不需要 `common/`**——common 规则从用户目录自动继承，无需重复配置。

**按需加载命令**：
```bash
cp -r subprojects/everything-claude-code/rules/<language> .claude/rules/ecc/
```

**技术栈→语言规则映射**：React/Next.js/Vue/Vite→web,typescript,react | Python/Django/FastAPI→python | Go→golang | Rust→rust | Java/Spring→java | Kotlin→kotlin | Swift/iOS→swift | Dart/Flutter→dart | C++→cpp | .NET/C#→csharp | PHP/Laravel→php | Ruby/Rails→ruby | Angular→angular,typescript,web | HarmonyOS/ArkTS→arkts | Node.js/Express→typescript | React Native/Expo→react,typescript

### Ralph Loop 关键步骤

> ⚠️ **PRD 生成后，必须等待用户输入 ralph 指令才能启动 Ralph Loop，禁止自动执行子任务。**

**PRD 生成后 → 工具预检**：Ralph Loop 的 gen/eva 无法自行登录或安装工具。PRD 生成后须执行预检，提醒用户哪些工具需提前准备：

```bash
python3 scripts/match_cli.py --preflight
```

检查输出中两类工具：
- **需要登录**：OpenCLI 站点适配器（cookie/ui 策略）需用户在 Chrome 中先登录
- **需要安装**：`mcp_install_cmd` 不为空的 MCP 工具需提前执行安装命令

提醒用户后，再等待 `ralph` 指令。

1. **子任务分析**: 先查skill索引表（BM25 match_skills.py）按需加载skill（辅助发现额外CLI），Claude Code自主判断CLI需求，合并后按需查cli-index.json。**禁止全量加载索引表**
2. **合同协商**: Generator↔Evaluator协商完成标准，成功锁定执行，失败回Generator重协商
3. **Generator**: ReAct+Daemon模式，按合同实现，调用skill/CLI工具
4. **Evaluator**: ReAct+Daemon模式，按合同验收，调用skill/CLI+ECC测试验证
5. **闭环**: 不通过→回Generator，通过→下一子任务。全部完成→阶段4

## 子项目体系

| 子项目 | 角色 | 权限 |
|--------|------|:---:|
| `subprojects/claude-skills-main/` | 技能来源1：348个skill | 只读 |
| `subprojects/ralph-harness/` | 工作流引擎+技能来源4：2个skill(prd/ralph) | 只读 |
| `subprojects/everything-claude-code/` | 技能来源2+验证工具：261个skill+子任务验证(阶段3)+最终验证(阶段4) | 只读 |
| `subprojects/awesome-mcp-servers/` | MCP服务目录，供OpenCLI转化 | 只读 |
| `subprojects/OpenCLI/` | 技能来源3+MCP→CLI转化(166个适配器) | **可写** |

## 工程约束

### 硬性约束（必须遵守）

1. **Plan模式禁改代码**（仅适用阶段1）: 进入Plan模式后，严格禁止修改任何代码。只能讨论、制定计划、使用CLI工具辅助分析、进行网络搜索分析可行性和方案。
2. **PRD生成后等待ralph指令**（阶段2→3边界）: PRD 生成后**禁止自动执行子任务**，必须等待用户输入 ralph 指令才能启动 Ralph Loop。
3. **网络搜索**: DeepSeek API 不兼容内置 WebFetch/WebSearch。改用 Exa MCP（`mcp__plugin_ecc_exa__web_search_exa`，使用前确认返回条数）、`mcp__github__search_code`、`mcp__plugin_context7_context7__query-docs`，降级用 `curl -sL`。
4. **CLI优先 > MCP**: 优先使用CLI工具。如只有MCP工具，通过OpenCLI转化为CLI并全局注册。既有MCP又有CLI时，只保留CLI。
5. **禁止降级处理**: 不能靠编写脚本替代使用CLI工具。必须直接调用。
6. **子项目只读保护（Security Constraint）**:
   以下子项目在生产环境中**严格只读**：
   - `subprojects/claude-skills-main/`
   - `subprojects/ralph-harness/`
   - `subprojects/everything-claude-code/`
   - `subprojects/awesome-mcp-servers/`
   只读规则（任何违规视为安全事件）：
   - 禁止在上述目录下**创建**新文件
   - 禁止**修改**上述目录下的已有文件
   - 禁止**删除**上述目录下的任何文件
   - 唯一允许的操作：`git pull` 同步上游更新
   - 如果必须修改：在独立克隆（如 ralph-main）中开发 → 推送上游 GitHub → `git submodule update --remote` 同步
   - `subprojects/OpenCLI/` 为可写（新增 MCP→CLI 适配器）
   每次操作前自查：当前操作是否涉及只读子项目文件？→ 如是，立即停止。
7. **ReAct + Daemon**: Generator和Evaluator均采用ReAct架构（先思考后调用工具循环），以Daemon模式运行确保中断后执行不中断。
8. **合同协商**: 每个子任务执行前，Generator和Evaluator必须先协商完成标准，协商成功锁定合同后执行，协商失败返回Generator重新协商。
9. **索引表按需渐进加载**: Skill索引表和CLI索引表**禁止一次性全部加载到上下文**。每次只搜索并加载当前子任务所需的条目，像Skill一样渐进式加载。索引表是搜索工具，不是参考资料。
10. **索引表查询顺序**: 先搜索Skill索引表（BM25 match_skills.py优先于search_index.py）→ 加载所需skill作为补充 → 结合Claude Code自主判断 → 搜索CLI索引表 → 最后搜索子项目源码。先查Skill是因为Skill能辅助发现额外的CLI工具。

### 设计原则

- **Skill去重合并**: 四个来源由 `scripts/build_temp_index.py` 扫描生成索引，`build_match_index.py` 构建BM25索引自动去重
- **索引表动态更新**: 子项目更新后，运行 `python3 scripts/build_temp_index.py` 重建
- **ECC双角色**: ECC同时承担技能提供和测试验证，覆盖阶段3（子任务验证）和阶段4（最终验证）
- **CLAUDE.md精简**: 每次对话完整加载，成型后应删除冗余内容

## 索引系统

> **按需搜索，禁止全量加载。**

### Skill 匹配（BM25 引擎，推荐）

```bash
python3 scripts/match_skills.py --json --top-k 5 "<任务描述>"    # BM25排名，推荐
python3 scripts/match_skills.py --name "react-patterns"          # 精确name查找
python3 scripts/match_skills.py --rebuild                        # 重建索引
```

**查询构造规则**：提取技术栈（框架名+语言名）+ 领域动作（state handling > button），去除通用词（fix/build/add），优先kebab-case组合词（"error handling" > "error"）。

**加载规则**：match_skills.py 返回 Top-5（含 name、score、description_preview）。Claude Code 自主判断是否加载 SKILL.md：
- 描述与任务相关 → 加载 | 无关（如 PayModal 命中 motion-patterns）→ 跳过
- **最多加载 5 个**，推荐 2-3 个最相关的。原则：宁可少加载正确 skill，不多加载错误 skill

### CLI 匹配（BM25 引擎）

三个数据源统一检索：cli-index.json（35工具） + OpenCLI manifest（~1049命令） + MCP README（~2282服务器）。

```bash
python3 scripts/match_cli.py "<查询词>"                                         # 基本搜索（默认Top-3）
python3 scripts/match_cli.py --json --top-k 3 "<查询词>"                        # JSON输出
python3 scripts/match_cli.py --source native,opencli "<查询词>"                  # 只看已有CLI
python3 scripts/match_cli.py --source mcp "<查询词>"                             # 只看MCP服务器
python3 scripts/match_cli.py --name "git clone"                                  # 精确名称查找
python3 scripts/match_cli.py --list                                              # 浏览全部条目
python3 scripts/match_cli.py --list --category version-control                   # 按分类浏览
python3 scripts/match_cli.py --rebuild                                           # 重建索引
```

**结果标记**：
- `[CLI]` — 原生CLI工具（git, npm, docker 等）
- `[OpenCLI]` — OpenCLI适配器（已转化为CLI的站点）
- `[MCP→CLI] [待转化]` — MCP服务器，尚未转化为CLI（分数已降权×0.7）
- MCP 结果附带 GitHub URL + 安装命令 + 转化提示

**CLI 加载规则**：match_cli.py 返回 Top-3 初筛结果。Claude Code 自主判断：
- **只选 1 个**最相关的 CLI 工具 — 与 skill 不同，CLI 不需要互补集合
- 初筛后可用 `--name "工具名"` 精确确认
- MCP 结果含 `[待转化]` 标记和转化提示

**索引结构**：`cli-match-index.json`（~5.4MB）分为两层：
- 用户可读：`entries[]`（工具目录）+ `name_index`（精确查找用）
- BM25 内部：`idf`（token 稀有度）+ `doc_tokens`（文档分词）+ `inverted`（倒排索引）

**索引构建**：`build_temp_index.py` 末尾自动触发 `build_cli_match_index.py`，生成 `cli-match-index.json`。

### 索引表数据源

- **skill-index.json**: 619 个 skill，`build_temp_index.py` 生成后自动触发 `build_match_index.py`
- **match-index.json**: BM25 skill 倒排索引，606 skill（去重后）
- **cli-index.json**: 35 个CLI工具（手工维护）
- **cli-match-index.json**: BM25 CLI 倒排索引，~3459 条目（native + OpenCLI + MCP 三源统一）
- **cli-manifest.json**: OpenCLI 适配器清单（`subprojects/OpenCLI/`）
- **README.md**: MCP 服务器目录（`subprojects/awesome-mcp-servers/`）

### 旧搜索方式（关键词匹配，备用）

```bash
python3 scripts/search_index.py --type skill --keyword "<英文关键词>"
python3 scripts/search_index.py --type skill --name "<exact-name>"
# CLI 关键词搜索已由 match_cli.py (BM25) 替代
```

## 使用

新任务：进入Plan模式 → 按需搜索索引表 → 生成PRD → 等待ralph指令启动Ralph Loop。
