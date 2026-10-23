# dsh-auto-review-default

让 DeepSeek Harness 的「**设置 → 通用 → 权限**」把实验性的「**自动审查**（Auto review）」列为可选的新会话默认档，并让**新会话默认就进入自动审查**。

> 面向 DSH `0.2.1-rc.2` 验证。插件依赖宿主内部实现，升级 DSH 后可能失效；失效时请停用该行。

## 为什么需要插件

宿主的三条硬约束让「自动审查」永远进不了设置页的默认列表：

1. 设置行只列**已配置预设**（`Object.keys(presets)`），而 `auto` 被保留给自动审查集成，**不允许**写进配置表（加载时会抛 `"auto" is reserved`）。
2. `defaultPreset` 在服务构造期就会 `resolve()`，此时集成尚未注册，写 `defaultPreset: auto` 会抛 `unknown preset "auto"`。
3. 设置写入走 HMR 事务（`configEditor.edit` → `runExclusive`），插件挂载期的调用会被拒绝：`HMR transactions cannot be nested`——AsyncLocalStorage 上下文会随定时器一起继承，延迟重试也没有用。

所以本插件**不写任何配置**，而是在运行时把 `auto` 发布成可配置预设，并覆盖默认值读取。

## 工作原理

| 步骤 | 作用 |
|---|---|
| 发布 | 集成存活时写入 `presets.auto = { sandbox: 'danger-full-access', approval: 'ask', name, description }`，让 `resolve("auto")`、`defaultOptions`、`defaultPreset` 都认得它；集成不在时立即撤下 |
| 去重 | 宿主 `names` getter 会把 `auto` 追加第二次，覆盖为去重版本 |
| 默认值 | 覆盖 `defaultSettings()`：**未存储过默认值时返回 `auto`**；一旦用户手动选择其它默认档，就以用户选择为准 |
| 时序自适应 | 集成注册晚于插件挂载时，由 `permission-presets/catalog-changed` 补发布 |
| 失效处理 | 集成消失时撤下 `auto`，并把已存的 `defaultPreset: auto` 恢复为 `workspace-write`，避免会话无法发布 |

## 安装

```sh
# 从 GitHub
dsh plugin --profile web add github:XavierMarquis93/dsh-auto-review-default

# 或从本地目录
dsh plugin --profile web add ./dsh-auto-review-default
```

前提：profile 已加载 `@deepseek-ai/dsh-experimental-auto-review`（自动审查集成本身）。未加载时本插件不会发布 `auto`，行为等同未安装。

安装后：**设置 → 通用 →「权限」**选择「自动审查」；此后新建的会话默认进入自动审查。

## 行为与限制

- **不写持久化 `defaultPreset`**：默认值由插件提供。因此停用/卸载插件后，默认值回落到「工作区内修改」。
- **重启 DSH** 时，官方集成会把处于 `auto` 的旧会话迁移为「完全权限」（内置行为），新会话仍是自动审查。
- 若移除自动审查集成：插件会撤下该选项；日志里记录为 `auto` 的旧会话将无法打开（内置限制）。
- 自动审查本身是实验性功能：每次工具调用都会多一次模型请求，可能误放行或误拒绝。

## 卸载

```sh
dsh plugin --profile web remove dsh-auto-review-default
```

或在「插件」页把 `auto-review-default` 行停用。

## English

`dsh-auto-review-default` makes the shipped experimental **Auto review** permission preset selectable as the new-session default in DeepSeek Harness.

The host structurally keeps `auto` out of the settings list: that list is built from configured presets, `auto` is reserved for the review integration, and a settings write made from a plugin mount transaction is rejected by the HMR runtime. This plugin therefore publishes the reserved identity into the live preset table while the integration is live, dedupes `names`, and overrides `defaultSettings()` so the effective default is `auto` until the user stores a different choice. It writes no configuration.

Install it into a profile that already loads `@deepseek-ai/dsh-experimental-auto-review`, then pick **自动审查 / Auto review** under Settings → General → Permission.

## License

MIT
