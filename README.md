# harness

以LLM为马，以项目目标为跑道，harness 为LLM提供全套"马具"——工作流、工具索引、技能系统——让AI驱动开发跑得更快更稳。

## 核心理念

harness 不直接产出代码，它编排5个专业化子项目，形成从需求分析到交付验证的完整AI开发流水线：

| 阶段 | 工具 | 产出 |
|------|------|------|
| 需求分析 | Plan模式 + Skill索引表（三来源：Claude Skills + ECC + OpenCLI） | 需求分析文档 |
| PRD生成 | Ralph Harness | 结构化PRD（含优先级） |
| 自主开发 | Ralph Loop：合同协商 → Generator → Evaluator | 子任务逐个完成 |
| 交付验证 | ECC 工具集（子任务验证 + 最终验证） | 验证报告 |

## 工程原则

- **Plan模式禁改代码**: 只讨论分析，不写代码；网络搜索必须获取有效内容，禁止0KB结束
- **Skill优先查询**: 先查Skill索引表 → 再查CLI索引表
- **CLI优先**: CLI工具 > MCP工具，MCP通过OpenCLI转化为CLI
- **ReAct + Daemon**: Generator和Evaluator均采用思考-行动循环，daemon守护防中断
- **合同协商**: 每个子任务执行前Generator和Evaluator先协商完成标准
- **子项目只读**: 仅通过git同步，不直接修改
- **Skill三来源去重**: Claude Skills + ECC + OpenCLI，合并冗余

## 子项目

```
subprojects/
├── claude-skills-main/      # 技能来源1
├── ralph-harness/           # 工作流引擎（含合同协商）
├── everything-claude-code/  # 技能来源2 + 测试验证（子任务+最终）
├── awesome-mcp-servers/     # MCP服务目录
└── OpenCLI/                 # 技能来源3 + MCP→CLI转化
```

## 快速开始

```bash
# 克隆子项目
cd subprojects
for repo in claude-skills-main ralph-harness everything-claude-code awesome-mcp-servers OpenCLI; do
  git clone https://github.com/m18897829375/$repo
done

# 详细文档见 CLAUDE.md
```
