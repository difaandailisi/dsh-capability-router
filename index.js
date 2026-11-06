/**
 * dsh-capability-router —— 宿主侧插件入口。
 *
 * 只做三件事：
 *   1. 注册一个工具 capability_route(need)：一句话需求 → 跨 技能/插件/MCP 的候选清单。
 *   2. 注入一段系统提示词，告诉模型"用户说的是需求而不是工具名时，先调这个工具"。
 *   3. 目录缓存 + 定期刷新。
 *
 * 硬约束见 AGENTS.md「不变量」一节。最要紧的两条：
 *   - 本文件任何一行抛异常，都会让整个 profile 启动失败。所以每个注册点都包 try/catch。
 *   - 工具 schema 走 dsh-tools 的 value-schema DSL：每个 object 节点都要显式
 *     additionalProperties，output.schema 根节点不能有 required。
 */

import { buildCatalog, route } from './lib/catalog.js';

export const name = 'dsh-capability-router';

// Cordis 会为 inject 里每个服务空等；这两个是宿主基础包必提供的。
export const inject = ['systemPrompt', 'tools'];

const DEFAULT_TTL_MS = 5 * 60 * 1000;

const PROMPT_SECTION = [
  '## 能力路由（capability-router）',
  '当用户描述的是**需求**而不是某个具体技能/插件/工具的名字时，先调用 `capability_route` 检索本机已具备的能力，再决定怎么做。',
  '典型触发：「有没有什么能…」「这件事该用什么」「帮我找个能做 X 的」「先看看有没有现成的」。',
  '规则：',
  '1. 先查再写。检索有强匹配就复用；没有强匹配（最高分低于 6）再考虑自己实现。',
  '2. 把命中的 `reasons` 直接转述给用户——那是可核对的依据，不要自己重算分数。',
  '3. `install` 字段只是待执行命令，**不要擅自安装**。装插件会执行第三方代码，必须先征得同意。',
  '4. 已装能力优先于新装能力，新装能力优先于从零写脚本。',
].join('\n');

function formatResults(need, terms, results, catalog) {
  const head = `检索「${need}」→ ${results.length} 条（catalog ${catalog.count} 条，更新时间 ${catalog.builtAt}）`;
  if (!results.length) {
    return [
      head,
      '没有强匹配。可能的原因：能力确实不存在，或它的描述里没写你会用的词。',
      '下一步建议：换一个说法再查一次；或直接自己实现（记得把产物沉淀成可复用的技能/插件）。',
      `本次用于匹配的词元：${terms.slice(0, 12).join('、') || '（空）'}`,
    ].join('\n');
  }
  const lines = results.map((item, i) => {
    const where = item.kind === 'plugin' && item.meta ? `${item.meta.profile} profile` : item.where;
    const tail = item.install ? `\n   安装命令（需人工确认）：${item.install}` : '';
    return `${i + 1}. [${item.kind}] ${item.title} — ${item.score} 分\n   ${item.reasons.join('；')}\n   位置：${where}${tail}`;
  });
  const weak = results[0].score < 6 ? '\n注意：最高分低于 6，属于弱匹配，建议先确认是不是你要的那个。' : '';
  return [head, ...lines, weak].filter(Boolean).join('\n');
}

export function apply(ctx, config = {}) {
  const ttl = Number.isFinite(config.ttlMs) ? config.ttlMs : DEFAULT_TTL_MS;
  let cache = { at: 0, data: null };

  const getCatalog = () => {
    if (cache.data && Date.now() - cache.at < ttl) return cache.data;
    try {
      cache = { at: Date.now(), data: buildCatalog(config) };
    } catch (error) {
      // 采集失败不能炸宿主：降级为上一次的快照（可能为空）。
      console.warn(`[capability-router] 目录采集失败：${error && error.message}`);
      if (!cache.data) cache = { at: Date.now(), data: { builtAt: 'n/a', count: 0, stats: {}, items: [] } };
      cache.at = Date.now();
    }
    return cache.data;
  };

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    try {
      ctx.tools.register({
        name: 'capability_route',
        description:
          '按意图检索本机能力：一句自然语言需求，同时匹配已装技能、DSH 插件与 MCP 服务器，返回带命中理由的候选清单。用户说的是需求而不是工具名时，先调这个再动手。纯本地、零网络、只读。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            need: { type: 'string', description: '用户的自然语言需求，中英文皆可，例如「任务完成时通知我」' },
            kind: { type: 'string', description: '可选，限定来源：skill / plugin / mcp' },
            limit: { type: 'integer', description: '可选，返回条数，默认 5，范围 1-20' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              text: { type: 'string' },
              hits: { type: 'integer' },
            },
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute(args) {
          const need = String(args?.need ?? '').trim();
          if (!need) {
            const catalog = getCatalog();
            return {
              text: `capability_route 需要 need 参数。当前目录：${catalog.count} 条 ${JSON.stringify(catalog.stats)}`,
              hits: 0,
            };
          }
          const catalog = getCatalog();
          const kind = ['skill', 'plugin', 'mcp'].includes(args?.kind) ? args.kind : undefined;
          const limit = Number.isFinite(args?.limit) ? args.limit : (config.limit || 5);
          const { terms, results } = route(need, { catalog, limit, kind });
          return { text: formatResults(need, terms, results, catalog), hits: results.length };
        },
      });
    } catch (error) {
      console.warn(`[capability-router] 工具注册失败：${error && error.message}`);
    }
  }

  if (config.injectPrompt !== false && ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    try {
      // order 100-199 是工具指引带；150 避免和其它插件的段落抢位。
      ctx.systemPrompt.section({
        name: 'capability-router',
        order: 150,
        interpolate: false,
        text: () => PROMPT_SECTION,
      });
    } catch (error) {
      console.warn(`[capability-router] 提示词注入失败：${error && error.message}`);
    }
  }
}
