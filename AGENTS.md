# AGENTS.md —— 给后续接手的人 / AI 的维护手册

> 这份文档的读者不是"用户"，是**下一个改这个仓库的人**（大概率是 AI）。
> 读它 30 秒能知道改哪里不会炸；跳过它，你有很大概率让所有用户的 DSH 起不来。
> 面向使用的说明在 [README.md](./README.md)。

---

## 0. 先记住三件事

1. `index.js` 里的 `apply()` **在宿主启动期执行**。它抛异常 = 整个 profile 启动失败 = 用户的白屏。
   所以每个注册点都必须包 `try/catch`，并且降级而不是抛出。
2. 工具 schema 不是普通 JSON Schema，是 `@deepseek-ai/dsh-tools` 的 **value-schema DSL**，有两条硬规则（见 §3.2）。违反任何一条，启动同样会失败。
3. 本项目**只读**。不写文件、不装包、不联网。这条一旦破坏，它就不再是一个可以放心默认安装的插件。

## 1. 项目地图

```
index.js              Cordis 插件入口：导出 name / inject / apply
  ├── 注册工具 capability_route
  ├── 注入系统提示词段落
  └── 目录缓存（TTL）
lib/catalog.js        纯函数层：采集 + 词元扩展 + 打分。零依赖，可单测
cordis.patch.yml      bundle 层补丁：把插件挂进 profile
test/catalog.test.mjs node:test，覆盖解析/打分/采集三类
package.json          peer 逐条枚举（见 §5），dsh.bundle 声明
```

数据流：`buildCatalog(config)` → `{ builtAt, count, stats, items[] }` → `route(need, {catalog})` → `{ terms, results[] }` → `formatResults()` → 文本。

**分层纪律**：`lib/catalog.js` 不 import `ctx`、不碰宿主 API、不做 I/O 之外的事。这样它才能被单测覆盖——这是本项目唯一可靠的回归防线。

## 2. 不变量（破坏任何一条都属于 breaking change）

| # | 不变量 | 为什么 |
|---|---|---|
| 1 | `apply()` 不抛异常 | 抛了宿主起不来 |
| 2 | 工具 schema 显式 `additionalProperties`，输出根节点无 `required` | DSL 强制，违者启动失败 |
| 3 | 零运行时依赖 | 插件跑在用户进程里，加依赖＝加供应链风险 |
| 4 | 只读：无写文件、无网络、无子进程 | 决定它能否被默认安装 |
| 5 | 条目的返回形状固定 `{id, kind, title, desc, tags, category, where, install?}` | index.js、测试、文档都依赖它 |
| 6 | 不自动安装 | 安装＝执行第三方代码，必须人工确认 |

## 3. 宿主契约

### 3.1 插件导出

```js
export const name = 'dsh-capability-router';
export const inject = ['systemPrompt', 'tools'];   // 只写宿主基础包必有的服务
export function apply(ctx, config) { /* ... */ }
```

`inject` 里的每个名字，Cordis 都会**空等**该服务出现。写进一个可能不存在的服务（比如某些发行版没有的 `pluginPackages`），宿主会 pending 到退出码 1。**加服务名之前先确认它属于基础包。**

### 3.2 工具注册（最容易踩的地方）

```js
ctx.tools.register({
  name: 'capability_route',
  description: '...',
  parameters: {
    type: 'object',
    additionalProperties: false,     // ← 必需：每个 object 节点都要显式布尔值
    properties: {
      need: { type: 'string' },
      limit: { type: 'integer' },
    },
    // 不要写 required —— 用代码里校验代替，避免 DSL 差异
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' }, hits: { type: 'integer' } },
      // ← 根节点绝对不能有 required，否则 profile 启动直接 abort
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  },
  async execute(args /*, exec */) { return { text, hits }; },
});
```

**两条硬规则（违反＝整个 profile 起不来）：**

1. 每个 `type: "object"` 节点必须声明显式布尔 `additionalProperties`
   → 报错形如 `parameters.<name>.additionalProperties must be explicitly true or false`
2. `output.schema` 的**根节点不能有 `required`**
   → 报错形如 `schema.required is not supported by the value schema DSL`
   （property 级的 `required: true` 是允许的）

历史教训：某同类项目正是用 JSON-Schema 的根级 `required`，导致宿主 `abort profile boot`，用户卸载前 DSH 完全打不开。

### 3.3 提示词段落

```js
ctx.systemPrompt.section({
  name: 'capability-router',
  order: 150,           // 0 = persona；100–199 = 工具指引带
  interpolate: false,
  text: () => PROMPT_SECTION,
});
```

`text` 是函数不是字符串——段落会在每次 assemble 时重算，允许按上下文变化。**没有这段注入，工具再准也不会被主动调用**：模型只会看到工具名，不会知道"用户说需求时该用它"。

## 4. 升级手册（dsh 换线时）

DSH 目前是 developer preview，破坏性变更频繁。**上游一发新线，按这个顺序做：**

1. `npm view @deepseek-ai/dsh-tools version` 确认新版本号。
2. 改 `package.json` 的 `peerDependencies`：**逐条枚举新的版本线**，不要图省事写成 `*` 或宽范围——`node-semver` 无法用单条范围表达"这些线的任意预发布版"，新线一来会静默不匹配。
3. 跑 `node --test`，再跑一次 `node -e "import('./index.js').then(m => m.apply(fakeCtx, {}))"` 冒烟。
4. 在真机上装一次，确认 profile 能起来（静态检查全绿也**不能**证明迁移完成）。
5. 更新 `README` 的兼容说明与 `CHANGELOG`。

> 心法：`engines.dsh` 与 `peerDependencies` 是**两条不同的门**。`engines` 只提要求，真正拒绝挂载的是 `peerDependencies` 比对（`evaluatePluginCompatibility`）。

## 5. 发布流程

> **先固化再发布。** 开发期插件是通过 `file:` 软链装进 profile 的——仓库一移动，宿主启动就会因为找不到模块而失败。定稿后务必走一次 tarball：
> `npm pack` → `npm install ./dsh-capability-router-0.1.0.tgz --legacy-peer-deps`，把依赖从软链换成实体副本。

```bash
# 1. 改版本（语义化：修 bug → patch，新能力 → minor）
npm version patch|minor

# 2. 确认发布内容（files 白名单里没有多余文件）
npm pack --dry-run

# 3. 发
npm publish

# 4. 打 tag 并在 README 记录「已实测的 dsh 版本」
git tag v0.1.x && git push --tags
```

**发布前必查：**
- [ ] `files` 白名单包含 `index.js / lib/ / cordis.patch.yml / README.md / AGENTS.md / LICENSE`
- [ ] `package.json` 的 `repository` / `bugs` / `homepage` 已改成真实地址（模板里是 `<your-name>`）
- [ ] 仓库 topic 加了 `dsh-plugin`，否则市场扫不到
- [ ] 许可证年号与作者已填

## 6. 测试

```bash
node --test          # 全部（Node 22+ 自动发现 *.test.mjs）
```

加新能力时**至少补一个测试**，优先级：
1. 打分规则变了 → 补 `scoreItem` 的权重断言
2. 新增数据源 → 补 `buildCatalog` 的采集数断言（用 tmp 目录，别依赖真实环境）
3. 新解析格式 → 补 `parseFrontmatter` 的坏输入用例（不抛异常是硬要求）

禁止写依赖网络或真实用户目录的测试——它们会在 CI 里随机失败。

## 7. 排错表

| 症状 | 最可能的原因 | 动作 |
|---|---|---|
| DSH 完全起不来，含 `additionalProperties must be explicitly` | schema 少了显式布尔 | 按 §3.2 补 |
| DSH 起不来，含 `schema.required is not supported` | 输出根节点带了 `required` | 删掉，改代码校验 |
| 装不上，提示 peer / compatibility | `peerDependencies` 没覆盖当前版本线 | 按 §4 逐条枚举 |
| 装完"插件装了但没反应" | 该包是 bundle 型，`dsh.profile.bundles` 只在启动读一次 | 重启；或改 patch 行热挂载 |
| 模型从不调用工具 | 提示词段落没注入 / 描述没写触发场景 | 检查 `injectPrompt`，看 `--dump-config` |
| 中文查询搜不到 | 插件条目只有包名，没读到 description | 确认 `collectPlugins` 读的是 `node_modules/<pkg>/package.json` |
| 目录条数远少于预期 | 技能分散在别处 | 加 `skillRoots`，或检查 `findSkillRoots` 深度 |

诊断命令：`dsh --profile <p> --dump-config` 看实际装配了什么。

## 8. 代码风格

- ESM only，无构建步骤。改完直接跑。
- 注释写**为什么**，不写**做了什么**（代码已经说明了）。
- 注释与文档用中文，标识符用英文。
- 新函数如果超过 40 行，先问自己能不能拆成"采集 / 打分 / 格式化"三段。
- 不要引入 `lodash` 这类工具库——`lib/catalog.js` 的价值就在于它是零依赖的。

## 9. 禁区

- ❌ 在 `apply()` 顶层做 I/O 或可能抛异常的事（启动期只做注册）
- ❌ 给工具加"顺手帮你安装"的选项
- ❌ 把目录缓存写到磁盘（违反只读）
- ❌ 用 `eval` / 动态 `require` / 编码过的 payload（会被安全扫描判为混淆）
- ❌ 在描述里堆关键词（会让打分失真，也让用户看不懂）

## 10. 交接检查清单

改完准备合并前，逐条打勾：

- [ ] `node --test` 全绿
- [ ] 用假 ctx 跑过 `apply()` 不抛异常
- [ ] 新增/修改的 object 节点都有 `additionalProperties`
- [ ] 输出 schema 根节点没有 `required`
- [ ] 没有引入运行时依赖
- [ ] 没有新增网络/写盘/子进程
- [ ] README 与 AGENTS 的表述和代码一致（改行为必须同步改文档）
- [ ] `CHANGELOG` 或 `npm version` 已记录
