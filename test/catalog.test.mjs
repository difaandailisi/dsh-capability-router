import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseFrontmatter,
  expandTerms,
  scoreItem,
  route,
  buildCatalog,
} from '../lib/catalog.js';

test('parseFrontmatter 解析扁平字段与列表', () => {
  const fm = parseFrontmatter(`---
name: demo
display_name: "演示"
tags:
  - a
  - b
description_zh: 一句话说明
---
# body`);
  assert.equal(fm.name, 'demo');
  assert.equal(fm.display_name, '演示');
  assert.deepEqual(fm.tags, ['a', 'b']);
  assert.equal(fm.description_zh, '一句话说明');
});

test('parseFrontmatter 对坏输入不抛异常', () => {
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
  assert.deepEqual(parseFrontmatter('---\nunclosed: true'), {});
  assert.deepEqual(parseFrontmatter(null), {});
});

test('expandTerms 中文出 2-gram 且带英文意图扩展', () => {
  const terms = expandTerms('自动审批');
  assert.ok(terms.includes('自动'));
  assert.ok(terms.includes('审批'));
  assert.ok(terms.includes('approval'), '应扩展出英文召回词');
});

test('expandTerms 英文按词切分', () => {
  const terms = expandTerms('search files');
  assert.ok(terms.includes('search'));
  assert.ok(terms.includes('files'));
});

test('scoreItem 名称权重高于描述', () => {
  const byName = scoreItem({ id: 'search-x', title: 'search-x', desc: '', tags: [] }, ['search']);
  const byDesc = scoreItem({ id: 'x', title: 'x', desc: 'search', tags: [] }, ['search']);
  assert.ok(byName.score > byDesc.score);
  assert.equal(byName.score, 3);
  assert.equal(byDesc.score, 1);
});

test('scoreItem 同字段最多计两次命中', () => {
  const many = scoreItem({ id: 'a b c d', title: '', desc: '', tags: [] }, ['a', 'b', 'c', 'd']);
  assert.equal(many.score, 6, '名称 3 分 × 命中上限 2');
});

test('route 排序、限条、按 kind 过滤', () => {
  const catalog = {
    count: 3,
    items: [
      { id: 'search-a', kind: 'skill', title: 'search-a', desc: '', tags: [] },
      { id: 'x', kind: 'plugin', title: 'x', desc: 'search', tags: [] },
      { id: 'y', kind: 'mcp', title: 'y', desc: '', tags: [] },
    ],
  };
  const all = route('search', { catalog, limit: 5 });
  assert.equal(all.results.length, 2);
  assert.equal(all.results[0].id, 'search-a');

  const onlyPlugin = route('search', { catalog, kind: 'plugin' });
  assert.deepEqual(onlyPlugin.results.map((r) => r.id), ['x']);
});

test('route 无命中返回空数组而不是抛错', () => {
  const { results } = route('完全无关的词', { catalog: { items: [] } });
  assert.deepEqual(results, []);
});

test('buildCatalog 采集技能、插件与 MCP 三类', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-router-'));
  const skillDir = path.join(tmp, 'skills', 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: demo-skill\ndisplay_name: 演示技能\ndescription_zh: 读写表格\ntags:\n  - sheet\n---\n# x\n',
  );

  const profileDir = path.join(tmp, 'profile');
  const modDir = path.join(profileDir, 'node_modules', 'dsh-foo');
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ name: 'p1', dependencies: { 'dsh-foo': '1.0.0' }, dsh: { profile: { bundles: [] } } }),
  );
  fs.writeFileSync(
    path.join(modDir, 'package.json'),
    JSON.stringify({ name: 'dsh-foo', description: 'auto approval reviewer', keywords: ['approval'] }),
  );

  const mcpFile = path.join(tmp, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { 'srv-a': { command: 'node a.js' } } }));

  const catalog = buildCatalog({
    skillRoots: [path.join(tmp, 'skills')],
    profileDirs: [profileDir],
    mcpFiles: [mcpFile],
  });

  assert.equal(catalog.stats.skill, 1);
  assert.equal(catalog.stats.plugin, 1);
  assert.equal(catalog.stats.mcp, 1);
  assert.equal(catalog.count, 3);

  const hit = route('自动审批', { catalog, limit: 3 });
  assert.equal(hit.results[0].id, 'dsh-foo', '读包自带 description，中文查询才可能命中');

  fs.rmSync(tmp, { recursive: true, force: true });
});
