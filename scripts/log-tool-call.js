#!/usr/bin/env node
/**
 * PostToolUse Hook — 记录 Claude Code 工具调用到 JSONL 日志。
 * CommonJS 格式，无需 package.json "type": "module"。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── 读取 stdin ──────────────────────────────────────────────────────────
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) { data += chunk; });
process.stdin.on('end', function () {
  try {
    if (!data.trim()) { process.exit(0); }

    var input = JSON.parse(data);
    var ts = new Date().toISOString();

    var record = {
      ts: ts,
      tool: input.tool_name || input.tool || 'unknown',
      role: detectRole(),
      pid: process.pid,
    };

    // 工具参数摘要
    if (input.tool_input) {
      if (typeof input.tool_input === 'object') {
        record.params = summarizeParams(input.tool_name || '', input.tool_input);
      } else {
        record.params = String(input.tool_input).slice(0, 200);
      }
    }

    // 文件路径（Write/Edit 工具）
    if (input.file_path) {
      record.file = input.file_path;
    }

    // Agent 名称（Agent 工具）
    if (input.tool_input && input.tool_input.subagent_type) {
      record.agent = input.tool_input.subagent_type;
    }

    // Skill 名称（Skill 工具）
    if (input.tool_name === 'Skill' && input.tool_input && input.tool_input.skill) {
      record.skill = input.tool_input.skill;
    }

    // Read 工具读取 SKILL.md → 转为 Skill 记录（只记实际加载的 skill）
    var readFilePath = (input.tool_input && input.tool_input.file_path) || input.file_path;
    if (input.tool_name === 'Read' && readFilePath) {
      var skillMatch = readFilePath.match(/[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i);
      if (skillMatch) {
        record.tool = 'Skill';
        record.skill = skillMatch[1];
        record.params = 'skill=' + skillMatch[1];
        delete record.command;
      }
    }

    // Bash 命令摘要 + CLI 工具识别（多规则匹配）
    if (input.tool_name === 'Bash' && input.tool_input && input.tool_input.command) {
      var cmd = input.tool_input.command.trim();
      record.command = cmd.slice(0, 300);

      // 多规则扫描整条命令，记录到 cli-calls.jsonl
      var cliCalls = [];
      var words = cmd.split(/[\s;|&]+/);

      // 规则1: opencli <site> <cmd>
      var ocMatch = cmd.match(/(?:^|[;|&\s])opencli\s+(\S+)\s+(\S+)/);
      if (ocMatch && OPENCLI_SET[ocMatch[1]]) {
        cliCalls.push({tool: 'opencli', site: ocMatch[1], cmd: ocMatch[2], rule: 'opencli'});
      } else if (ocMatch) {
        // opencli 但 site 不在注册表中，仍记录
        cliCalls.push({tool: 'opencli', site: ocMatch[1], cmd: ocMatch[2], rule: 'opencli'});
      }

      // 规则2: 已知原生工具（从 registry 匹配，全词匹配）
      for (var i = 0; i < words.length; i++) {
        if (NATIVE_SET[words[i]] && words[i] !== 'opencli') {
          // 避免重复（同一条命令中同一工具多次出现只记一次）
          var dup = false;
          for (var d = 0; d < cliCalls.length; d++) {
            if (cliCalls[d].tool === words[i]) { dup = true; break; }
          }
          if (!dup) {
            cliCalls.push({tool: words[i], rule: 'native'});
          }
        }
      }

      // 规则3: npx <package>
      var npxMatch = cmd.match(/(?:^|[;|&\s])npx\s+(?:-y\s+)?(\S+)/);
      if (npxMatch) {
        var dupNpx = false;
        for (var d2 = 0; d2 < cliCalls.length; d2++) {
          if (cliCalls[d2].tool === 'npx') { dupNpx = true; break; }
        }
        if (!dupNpx) cliCalls.push({tool: 'npx', pkg: npxMatch[1], rule: 'npx'});
      }

      // 填充 record.cli（向后兼容）
      if (cliCalls.length > 0) {
        record.cli = cliCalls[0].tool;
        record.cli_all = cliCalls.map(function(c) { return c.tool; });
        record.cli_rule = cliCalls[0].rule;
        // 将 tool 从 "Bash" 重写为 "CLI:<工具名>"，方便过滤
        record.tool = 'CLI:' + cliCalls[0].tool;
        // opencli 提取子命令
        if (cliCalls[0].tool === 'opencli') {
          record.cli_subcmd = cliCalls[0].site;
        }
      }

      // 写入独立 CLI 日志
      if (cliCalls.length > 0) {
        var ralphDir2 = findProjectDir() ? path.join(findProjectDir(), '.ralph') : null;
        if (!ralphDir2) { ralphDir2 = path.join(process.cwd(), '.ralph'); }
        if (!fs.existsSync(ralphDir2)) { fs.mkdirSync(ralphDir2, { recursive: true }); }
        var cliLogFile = path.join(ralphDir2, 'cli-calls.jsonl');
        for (var j = 0; j < cliCalls.length; j++) {
          var entry = {
            ts: ts,
            role: record.role,
            tool: cliCalls[j].tool,
            rule: cliCalls[j].rule,
            full_command: cmd.slice(0, 500),
          };
          if (cliCalls[j].site) entry.site = cliCalls[j].site;
          if (cliCalls[j].cmd) entry.cmd = cliCalls[j].cmd;
          if (cliCalls[j].pkg) entry.pkg = cliCalls[j].pkg;
          fs.appendFileSync(cliLogFile, JSON.stringify(entry) + '\n', 'utf8');
        }
      }
    }

    // ── Index Search 调用识别 ──────────────────────────────────────────
    if (input.tool_name === 'Bash' && input.tool_input && input.tool_input.command) {
      var cmd = input.tool_input.command.trim();
      var idxMatch = cmd.match(/python3\s+(?:[^\s]*\/)?scripts\/(match_cli\.py|match_skills\.py|search_index\.py)\s*(.*)/);
      if (idxMatch) {
        record.index_search = idxMatch[1].replace('.py', '');
        var argsStr = idxMatch[2] || '';
        // 提取查询词（双引号包裹的字符串）
        var qm = argsStr.match(/"([^"]+)"/);
        if (qm) record.search_query = qm[1].slice(0, 200);
        // 提取参数
        if (argsStr.includes('--json')) record.search_json = true;
        if (argsStr.includes('--rebuild')) record.search_rebuild = true;
        var tkm = argsStr.match(/--top-k\s+(\d+)/);
        if (tkm) record.search_top_k = parseInt(tkm[1], 10);
        var sm = argsStr.match(/--source\s+(\S+)/);
        if (sm) record.search_source = sm[1];
        var tm = argsStr.match(/--type\s+(skill|cli)/);
        if (tm) record.search_type = tm[1];
      }
    }

    // 写入 JSONL
    var projectDir = findProjectDir();
    var ralphDir = path.join(projectDir, '.ralph');
    if (!fs.existsSync(ralphDir)) {
      fs.mkdirSync(ralphDir, { recursive: true });
    }
    var logFile = path.join(ralphDir, 'tool-calls.jsonl');
    fs.appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    if (process.env.RALPH_TOOL_LOG_DEBUG) {
      console.error('[log-tool-call] Error:', err.message);
    }
  }
  process.exit(0);
});

// ── 加载 CLI 工具注册表 ──────────────────────────────────────────────────
var NATIVE_TOOLS = [];
var OPENCLI_SITES = [];
try {
  var projectDir = findProjectDir();
  var regPath = path.join(projectDir, 'cli-tool-registry.json');
  if (fs.existsSync(regPath)) {
    var reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
    NATIVE_TOOLS = reg.native_tools || [];
    OPENCLI_SITES = reg.opencli_sites || [];
  }
} catch (e) { /* registry 不存在时回退到硬编码 */ }
if (NATIVE_TOOLS.length === 0) {
  NATIVE_TOOLS = ['git','npm','node','npx','bash','jq','curl','playwright','docker','pip','go','cargo'];
}
if (OPENCLI_SITES.length === 0) {
  OPENCLI_SITES = ['bilibili','twitter','zhihu','github'];
}
// 快速查找 Set
var NATIVE_SET = {};
for (var ni = 0; ni < NATIVE_TOOLS.length; ni++) { NATIVE_SET[NATIVE_TOOLS[ni]] = true; }
var OPENCLI_SET = {};
for (var oi = 0; oi < OPENCLI_SITES.length; oi++) { OPENCLI_SET[OPENCLI_SITES[oi]] = true; }
function detectRole() {
  if (process.env.RALPH_ROLE) return process.env.RALPH_ROLE;
  return 'main';
}

// ── 参数摘要 ────────────────────────────────────────────────────────────
function summarizeParams(toolName, input) {
  var fields = [];
  if (input.description) fields.push('desc="' + input.description.slice(0, 60) + '"');
  if (input.prompt) fields.push('prompt="' + input.prompt.slice(0, 80) + '"');
  if (input.subagent_type) fields.push('agent=' + input.subagent_type);
  if (input.model) fields.push('model=' + input.model);
  if (input.skill) fields.push('skill=' + input.skill);
  if (input.command) fields.push('cmd="' + input.command.slice(0, 60) + '"');
  if (input.file_path) fields.push('file="' + input.file_path + '"');
  return fields.length > 0 ? fields.join(', ') : '(no summary)';
}

// ── 定位项目目录 ────────────────────────────────────────────────────────
function findProjectDir() {
  if (process.env.RALPH_PROJECT_DIR) return process.env.RALPH_PROJECT_DIR;
  return process.cwd();
}
