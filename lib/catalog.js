/**
 * catalog.js —— 能力目录的采集与评分。纯函数、零依赖、不触网。
 *
 * 设计约束（改这个文件前先读 AGENTS.md）：
 *   1. 只用 Node 内置模块。插件跑在宿主进程里，加依赖等于给每个用户加一份供应链风险。
 *   2. 只读。绝不写文件、不装包、不发网络请求。
 *   3. 返回结构固定 { id, kind, title, desc, tags, category, where, install? }，
 *      index.js 与测试都依赖这个形状。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CORE_PACKAGE = /^@deepseek-ai\//;

/** 中文意图词 → 英文召回词。没有它，中文查询对英文描述等于零召回。
 *  加词的门槛：至少两个不同插件会用到它，否则会把噪音放大。 */
const INTENT_LEXICON = {
  审批: ['approval', 'approve', 'review'],
  同意: ['approval', 'approve'],
  自动: ['auto', 'automatic'],
  搜索: ['search', 'find', 'query'],
  查找: ['search', 'find', 'lookup'],
  通知: ['notify', 'notification', 'alert'],
  提醒: ['remind', 'alert', 'notify'],
  记忆: ['memory', 'memo', 'recall'],
  上下文: ['context', 'compact'],
  会话: ['session', 'conversation'],
  对话: ['chat', 'conversation'],
  截图: ['screenshot', 'capture'],
  图片: ['image', 'picture'],
  翻译: ['translate', 'translation'],
  浏览器: ['browser', 'playwright', 'puppeteer'],
  网页: ['web', 'page', 'http'],
  文件: ['file', 'filesystem', 'fs'],
  磁盘: ['disk', 'storage'],
  清理: ['clean', 'cleanup', 'purge'],
  备份: ['backup', 'snapshot'],
  回滚: ['rollback', 'restore', 'revert'],
  安装: ['install', 'package'],
  插件: ['plugin', 'bundle'],
  技能: ['skill'],
  安全: ['security', 'audit', 'vet'],
  文档: ['doc', 'document', 'docx'],
  表格: ['sheet', 'xlsx', 'excel'],
  演示: ['slide', 'pptx', 'presentation'],
  语音: ['voice', 'tts', 'speech'],
  视频: ['video', 'ffmpeg'],
  数据库: ['database', 'sql', 'db'],
  代码: ['code', 'source'],
  任务: ['task', 'job'],
  日程: ['schedule', 'calendar'],
  进度: ['progress', 'status'],
  主题: ['theme', 'skin'],
  界面: ['ui', 'interface'],
  侧栏: ['sidebar', 'panel'],
  提示词: ['prompt'],
  模型: ['model', 'llm'],
  兼容: ['compat', 'compatibility'],
  升级: ['upgrade', 'update', 'migrate'],
  监控: ['monitor', 'watch', 'observe'],
};

export const FIELD_WEIGHTS = { name: 3, tags: 2, category: 2, description: 1 };

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function readJson(file) {
  return safe(() => JSON.parse(fs.readFileSync(file, 'utf8')), null);
}

function listDir(dir) {
  return safe(() => fs.readdirSync(dir, { withFileTypes: true }), []);
}

function exists(file) {
  return safe(() => fs.existsSync(file), false);
}

/** 只解析技能 frontmatter 的扁平行：key: value 与 key: 换行 - item。
 *  不做完整 YAML —— 为了不起一个依赖，也为了坏掉的 frontmatter 不炸整个目录。 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const out = {};
  let listKey = null;
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      if (val === '') { out[key] = []; listKey = key; continue; }
      listKey = null;
      out[key] = val.replace(/^['"]|['"]$/g, '').trim();
      continue;
    }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && listKey) out[listKey].push(li[1].replace(/^['"]|['"]$/g, '').trim());
  }
  return out;
}

/** 递归找名为 skills 的目录，用于覆盖插件缓存里挂着的那批技能。 */
function findSkillRoots(root, depth = 0, out = []) {
  if (depth > 5) return out;
  for (const entry of listDir(root)) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    if (entry.name === 'skills') { out.push(full); continue; }
    findSkillRoots(full, depth + 1, out);
  }
  return out;
}

export function collectSkills(roots) {
  const items = [];
  const seen = new Set();
  for (const root of roots) {
    for (const entry of listDir(root)) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, 'SKILL.md');
      if (!exists(file)) continue;
      const fm = parseFrontmatter(safe(() => fs.readFileSync(file, 'utf8'), ''));
      const id = fm.name || entry.name;
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        kind: 'skill',
        title: fm.display_name || fm.display_name_en || fm.name || entry.name,
        desc: [fm.description_zh, fm.description_en].filter(Boolean).join(' '),
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        category: fm.category || '',
        where: file,
      });
    }
  }
  return items;
}

export function collectPlugins(profileDirs) {
  const items = [];
  for (const profileDir of profileDirs) {
    const pkgPath = path.join(profileDir, 'package.json');
    const pkg = readJson(pkgPath);
    if (!pkg) continue;
    const profile = pkg.name || path.basename(profileDir);
    const modules = path.join(profileDir, 'node_modules');
    const seen = new Set();

    for (const [name, version] of Object.entries(pkg.dependencies || {})) {
      if (CORE_PACKAGE.test(name)) continue;
      seen.add(name);
      const meta = readJson(path.join(modules, name, 'package.json')) || {};
      items.push({
        id: name,
        kind: 'plugin',
        title: name,
        desc: meta.description || `已安装在 ${profile} profile（版本 ${version}）`,
        tags: Array.isArray(meta.keywords) ? meta.keywords : [],
        category: 'installed',
        where: pkgPath,
        install: null,
        meta: { profile, version },
      });
    }

    for (const name of pkg.dsh?.profile?.bundles || []) {
      if (CORE_PACKAGE.test(name) || seen.has(name)) continue;
      seen.add(name);
      const meta = readJson(path.join(modules, name, 'package.json')) || {};
      items.push({
        id: name,
        kind: 'plugin',
        title: name,
        desc: meta.description || `${profile} profile 的 bundle 层（启动时装配）`,
        tags: Array.isArray(meta.keywords) ? meta.keywords : [],
        category: 'bundle',
        where: pkgPath,
        install: null,
        meta: { profile, version: 'bundle' },
      });
    }
  }
  return items;
}

export function collectMcp(mcpFiles) {
  const items = [];
  const seen = new Set();
  const push = (name, desc, tags, where) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    items.push({ id: name, kind: 'mcp', title: name, desc: desc || 'MCP 服务器', tags: tags || [], category: 'mcp', where, install: null });
  };

  for (const file of mcpFiles) {
    const json = readJson(file);
    if (!json) continue;
    const servers = json.mcpServers || json.servers;
    if (!servers) continue;
    const rows = Array.isArray(servers)
      ? servers.map((s) => [s?.name, s])
      : Object.entries(servers);
    for (const [name, cfg] of rows) {
      const desc = typeof cfg === 'object' && cfg ? (cfg.description || cfg.command || cfg.url) : String(cfg || '');
      push(name, desc, [], file);
    }
  }

  const known = readJson(path.join(path.dirname(mcpFiles[0] || ''), 'tool-management', 'mcp-known-tools.json'));
  if (known) {
    const rows = Array.isArray(known) ? known : Object.entries(known).map(([k, v]) => ({ name: k, ...(v || {}) }));
    for (const row of rows) {
      const name = row.name || row.server || row.id;
      const tools = Array.isArray(row.tools)
        ? row.tools.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean)
        : [];
      push(name, tools.length ? `已知工具：${tools.slice(0, 8).join(', ')}` : 'MCP 服务器（工具清单未知）', tools.slice(0, 12), 'mcp-known-tools.json');
    }
  }
  return items;
}

/** 查询 → 词元。中文出 2-gram（子串匹配够用且可解释），英文出词，再挂意图词典的扩展词。 */
export function expandTerms(query) {
  const q = String(query || '').toLowerCase();
  const set = new Set();
  for (const word of q.split(/[^a-z0-9_\u4e00-\u9fa5-]+/).filter(Boolean)) {
    if (CJK_TEST(word)) {
      if (word.length <= 2) set.add(word);
      for (let i = 0; i + 2 <= word.length; i += 1) set.add(word.slice(i, i + 2));
      for (const [cn, ens] of Object.entries(INTENT_LEXICON)) {
        if (word.includes(cn)) ens.forEach((e) => set.add(e));
      }
    } else if (word.length >= 2) {
      set.add(word);
    }
  }
  return [...set];
}

function CJK_TEST(s) {
  return /[\u4e00-\u9fa5]/.test(s);
}

/** 打分：命中字段 × 权重，同字段最多计两次命中，避免长描述靠词多取胜。 */
export function scoreItem(item, terms) {
  const fields = [
    ['名称', `${item.id} ${item.title}`.toLowerCase(), FIELD_WEIGHTS.name],
    ['标签', (item.tags || []).join(' ').toLowerCase(), FIELD_WEIGHTS.tags],
    ['分类', String(item.category || '').toLowerCase(), FIELD_WEIGHTS.category],
    ['描述', String(item.desc || '').toLowerCase(), FIELD_WEIGHTS.description],
  ];
  let total = 0;
  const reasons = [];
  for (const [label, text, weight] of fields) {
    if (!text) continue;
    const hits = terms.filter((t) => text.includes(t));
    if (!hits.length) continue;
    const gain = weight * Math.min(hits.length, 2);
    total += gain;
    reasons.push(`${label}命中「${hits.slice(0, 3).join('、')}」+${gain}`);
  }
  return { score: total, reasons };
}

/** 采集 + 评分 + 取前 k。返回纯数据，格式化交给调用方。 */
export function route(need, options = {}) {
  const { catalog, limit = 5, kind } = options;
  const terms = expandTerms(need);
  const results = (catalog.items || [])
    .filter((item) => !kind || item.kind === kind)
    .map((item) => ({ ...item, ...scoreItem(item, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(20, limit)));
  return { terms, results };
}

export function resolveRoots(config = {}) {
  const home = os.homedir();
  const expand = (p) => (typeof p === 'string' && p.startsWith('~') ? path.join(home, p.slice(1)) : p);
  const dshHome = process.env.DSH_HOME || path.join(home, '.dsh');
  const profilesDir = path.join(dshHome, 'profiles');
  const extra = (config.extraSkillRoots || []).map(expand).filter(Boolean);
  const skillRoots = [
    path.join(dshHome, 'skills'),
    path.join(home, '.agents', 'skills'),
    ...findSkillRoots(path.join(dshHome, 'plugins')),
    ...extra.flatMap((root) => [root, ...findSkillRoots(root)]),
  ];
  const profileDirs = listDir(profilesDir)
    .filter((d) => d.isDirectory())
    .map((d) => path.join(profilesDir, d.name));
  const mcpFiles = [
    path.join(dshHome, 'mcp.json'),
    path.join(home, '.workbuddy', 'mcp.json'),
  ];
  return {
    dshHome,
    skillRoots: config.skillRoots || skillRoots,
    profileDirs: config.profileDirs || profileDirs,
    mcpFiles: config.mcpFiles || mcpFiles,
  };
}

export function buildCatalog(config = {}) {
  const roots = resolveRoots(config);
  const skills = config.sources?.skills === false ? [] : collectSkills(roots.skillRoots);
  const plugins = config.sources?.plugins === false ? [] : collectPlugins(roots.profileDirs);
  const mcp = config.sources?.mcp === false ? [] : collectMcp(roots.mcpFiles);
  const items = [...skills, ...plugins, ...mcp];
  const stats = items.reduce((acc, item) => {
    acc[item.kind] = (acc[item.kind] || 0) + 1;
    return acc;
  }, {});
  return { builtAt: new Date().toISOString(), count: items.length, stats, items };
}
