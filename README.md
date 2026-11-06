# dsh-capability-router

**一句话需求，跨三类能力检索：已装技能、DSH 插件、MCP 服务器。**

纯本地、零依赖、只读。不联网，不调 LLM，不装东西。

---

## 它解决什么

模型能调用什么，取决于**会话启动时上下文里有什么**。于是出现三个具体问题：

1. **看不见就想不到。** 目录外的能力对模型等于不存在，用户得先记住名字。
2. **中文查询零召回。** 插件描述几乎都是英文，用户说的是"自动审批""免确认"。
3. **三类割裂。** 技能在文件系统、插件在 profile、MCP 在另一份配置，没有统一入口。

`dsh-capability-router` 把三类归一成一张目录，用一个工具按意图检索，返回**带命中理由**的候选。

## 它怎么工作

```
需求 ──► 词元扩展 ──► 三类目录打分 ──► 候选 + 理由
         (中文2-gram          (技能 / 插件 / MCP)
          + 中英意图词典)
```

- **采集**：技能读 `SKILL.md` frontmatter；插件读 profile 的 `package.json` 与包自带 `description/keywords`；MCP 读 `mcp.json` 与 `mcp-known-tools.json`。
- **打分**：名称 +3、标签 +2、分类 +2、描述 +1；同字段最多计两次，避免长描述靠词多取胜。
- **引导**：注入一段系统提示词，告诉模型「用户说的是需求而不是工具名时，先调这个工具」——这是让它**主动**被用到的关键一手，光有工具没用。

## 安装

```bash
# 方式一：bundle（进 dsh.profile.bundles，启动时装配）
dsh plugin --profile web add dsh-capability-router

# 方式二：本地开发，软链进 profile 后手工加热挂载行
npm install /path/to/dsh-capability-router --legacy-peer-deps
```

方式二需要在 profile 的 `cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: capability-router
      name: dsh-capability-router
```

patch 层由 HMR 监视，**改完即生效，不用重启**；bundle 层要重启。

## 使用

模型侧一个工具：

```
capability_route(need: "任务完成时通知我", limit?: 5, kind?: "plugin")
```

返回：

```
检索「自动审批 不用我每次点同意」→ 1 条（catalog 181 条，更新时间 ...）
1. [plugin] dsh-auto-review — 12 分
   名称命中「review、auto」+6；标签命中「approval、review、auto」+4
   位置：desktop profile
```

模型可以直接转述 `reasons`，不必自己重算分数。

## 配置

在 patch 行里覆盖（patch 会整体替换 config，记得把要保留的键全部重述）：

```yaml
- id: capability-router
  name: dsh-capability-router
  config:
    ttlMs: 300000        # 目录缓存时长，默认 5 分钟
    limit: 5             # 默认返回条数
    injectPrompt: true   # 是否注入引导段落
    extraSkillRoots:     # 额外技能根目录，支持 ~；会递归找其中的 skills/ 子目录
      - ~/.workbuddy/skills
    sources:
      skills: true
      plugins: true
      mcp: true
```

`extraSkillRoots` 是为「同时跑多个 harness」的场景准备的：DSH 本机没有技能、而技能都在别的工具目录时，把它们挂进来即可统一检索。

## 设计取舍

- **为什么不用向量检索**：插件目录是几十到几百条，2-gram + 意图词典的召回已经够用，而且**可解释**（每条都能说出为什么命中）、零延迟、零模型调用。规模和精度冲突时，先保住可解释性。
- **为什么读包自带 description**：只记包名时中文查询召回为 0。这一条是实测出来的，不是设计洁癖。
- **为什么不自动安装**：装插件等于执行第三方代码。工具只给命令，不代表可以执行。

## 与 WorkBuddy 技能共用同一引擎

`lib/catalog.js` 是纯函数、零依赖，所以可以被**别的宿主**直接复用，而不必复制一份逻辑：

```
dsh-capability-router/            插件本体（Cordis apply）
        └── lib/catalog.js  ◄────  ~/.workbuddy/skills/capability-router/
                                     └── vendor/node_modules/dsh-capability-router（软链）
                                     └── scripts/scan.mjs（薄 CLI，只做参数转接）
```

WorkBuddy 的扩展机制是 `SKILL.md`，加载不了 Cordis 插件；但它的 CLI 可以直接 import 这个引擎，于是**两个宿主同一份采集与打分代码**，不会各自漂移。这本身就是本仓库主张的那件事：能力定义一处，实现多处复用。

## 局限

- 召回质量取决于**描述质量**。描述里没写你会用的词，就搜不到——这也是为什么要在技能/插件里写好触发语义。
- 只覆盖本机已装能力，不含远端市场索引。
- 中文靠 2-gram 子串，长句会有噪音；短需求效果最好。

## 与生态里其它项目的关系

| 项目 | 覆盖 | 与本项目的差异 |
|---|---|---|
| dsh-need-finder | 插件（精选 84 条） | 本项目覆盖三类，且目录来自本机实际安装 |
| dsh-skills-anywhere | 技能 | 本项目把技能与插件、MCP 放进同一排序 |
| dsh-cap-manager | 技能+MCP 的**管理面板** | 本项目只做**检索**，不做增删改 |
| dsh-vet | 安装前安全审计 | 互补：本项目告诉你装什么，它告诉你该不该装 |

## 路线图

- [ ] 目录热更新（监听文件变化，而不是 TTL 轮询）
- [ ] 可选向量召回（作为精排层，不替代可解释打分）
- [ ] 结果里带「上次谁用过 / 成功率」
- [ ] 与 `dsh plugin add` 打通，直接给可点击的确认

## 许可

MIT。见 [LICENSE](./LICENSE)。

维护者/贡献者须知见 [AGENTS.md](./AGENTS.md) —— 那份文件是写给 AI 协作者看的，人和 AI 都该读。
