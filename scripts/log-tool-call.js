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

    // Bash 命令摘要 + CLI 工具识别
    if (input.tool_name === 'Bash' && input.tool_input && input.tool_input.command) {
      var cmd = input.tool_input.command.trim();
      record.command = cmd.slice(0, 300);

      // 提取 CLI 工具名（对照 cli-index.json 已知工具列表）
      var firstWord = cmd.split(/\s+/)[0];
      var KNOWN_CLI = [
        'git','npm','node','npx','bash','jq','curl','playwright',
        'ecc','opencli','tsx','tsc','eslint','pytest','vitest',
        'go','cargo','gradle','docker','pm2','uv','pip','pnpm',
        'yarn','bun','mkdocs','ralph','python3','claude',
      ];
      if (KNOWN_CLI.indexOf(firstWord) >= 0) {
        record.cli = firstWord;
        // opencli 提取子命令（站点适配器名）
        if (firstWord === 'opencli') {
          var parts = cmd.split(/\s+/);
          if (parts.length >= 2) record.cli_subcmd = parts[1];
        }
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

// ── 检测当前角色 ────────────────────────────────────────────────────────
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
