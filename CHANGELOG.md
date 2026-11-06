# Changelog

本文件记录所有值得用户注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-06

首个可用版本。

### 新增

- 工具 `capability_route(need, limit?, kind?)`：一句自然语言需求，跨三类能力返回带命中理由的候选。
- 三类数据源：技能（`SKILL.md` frontmatter）、DSH 插件（profile 依赖 + 包自带 `description/keywords`）、MCP（`mcp.json` 与 `mcp-known-tools.json`）。
- 评分规则：名称 +3、标签 +2、分类 +2、描述 +1，同字段最多计两次。
- 中文 2-gram 切分 + 中英意图词典（40 组），解决中文查询对英文描述零召回。
- 系统提示词段落注入（order 150），让工具在"用户说需求"时被主动调用。
- 目录 TTL 缓存，默认 5 分钟。
- `extraSkillRoots` 配置：接入其它 harness 的技能目录，支持 `~` 并递归查找 `skills/` 子目录。

### 设计约束

- 零运行时依赖、只读、不联网、不自动安装。

[0.1.0]: https://github.com/difaandailisi/dsh-capability-router/releases/tag/v0.1.0
