# dsh-auto-review-default

让 DeepSeek Harness 的「**设置 → 通用 → 权限**」把实验性的「**自动审查**（Auto review）」作为**新会话默认权限**，并修掉随之而来的两类故障：

- `gateway/service-unavailable: permissionPresets/catalog: active Service "permissionPresets" is unavailable`（改权限时报错）
- 「设置里选的默认权限不生效，新会话不跟随」（读取路径失效）

> 面向 DSH `0.2.x` 验证。插件依赖宿主内部实现，升级 DSH 后可能需要跟进；出问题时把该行停用即可完全恢复原生行为。

## 为什么需要插件

宿主的四条硬约束决定了 `auto` 只能在**运行期**存在，不能写成配置：

1. 设置页默认档列表来自 `Object.keys(presets)`，而 `auto` 是**保留标识**，写进配置表会在加载时抛 `permission: "auto" is reserved`。
2. `defaultPreset` 在服务构造期就会 `this.resolve(defaultPreset)`，此时自动审查集成尚未注册，存 `auto` 会抛 `permission: unknown preset "auto"` —— 该 entry 挂载失败，**整个权限服务不可用**（设置里连行都不会出现，插件也没机会自救）。
3. 因为 (2)，`auto` 只能由插件在运行时发布到服务的预设表上，并覆盖默认值读取。
4. 插件**不能改写 Loader 的 resolved config**：`service.presets` 与宿主 `config.presets`、`fiber.config.presets` 是同一个对象。`cordis-plugin-loader` 用 `deepEqual(fiber.config, candidate, true)` 判断一次设置写入能否走「热更新」，多出一个键就会退化为**整插件重启**；重启窗口内 provider fiber 不是 ACTIVE，`ctx.get(name, strict)` 跳过它，网关便回 `gateway/service-unavailable`。

## 工作原理

| 环节 | 做法 |
|---|---|
| 发布 | 集成存活时把 `auto` 合进**服务实例**的预设表（`service.presets = { ...宿主表, auto }`），宿主 `config.presets` 保持原对象不动；集成不在时还原宿主表 |
| 去重 | 宿主 `names` getter 会再追加一次 `auto`，覆盖为去重版本 |
| 默认值 | 覆盖 `defaultSettings()`，**按三级兜底读取用户配置**：运行中 fiber 的 resolved config → profile 落盘的 raw config → 设置行实际显示的值。只有三级都读不到时才返回 `auto` |
| 读取路径 | 不再调用 `settings.describe()`：它是有副作用的读（重建所有行、推高 document revision、发 `settings/document-updated`），且在 settings 服务尚未就绪时会静默返回空 |
| 写入拦截 | `set defaultPreset=auto` 翻译为「清空该字段」，因此 `auto` 永远不会落盘；`mutate`/`update`/`replace` 都覆盖，`expectedRevision` 原样保留 |
| 配置兜底 | 注册 `internal/config` waterfall，丢弃任何来源的 `defaultPreset: auto`，保证宿主构造函数永远看不到它 |
| 时序自适应 | 集成注册晚于插件挂载时，由 `permission-presets/catalog-changed` 补发布 |
| 不写配置 | 插件自己从不发起任何设置写入 |

## 安装

```sh
# 从 GitHub（推荐）
dsh plugin --profile <你的 profile> add github:XavierMarquis93/dsh-auto-review-default

# 或从本地目录
dsh plugin --profile <你的 profile> add ./dsh-auto-review-default
```

安装后**重启 DSH**（插件代码只在启动时加载，没有 HMR）。

前提：profile 已加载 `@deepseek-ai/dsh-experimental-auto-review`（自动审查集成本身）。未加载时本插件不会发布 `auto`，行为等同未安装。

## 使用

1. 打开「设置 → 通用 → 权限」，「新会话默认权限」应显示 **自动审查 (Auto review)**。
2. 新建会话，权限选择器应为「自动审查」（`danger-full-access` + `ask`）。
3. 想换默认：在同一行选一个具体预设（如「工作区」），**新会话会跟随你的选择**；本插件的默认值只在「三级兜底都读不到配置」时生效。

## 行为与限制

- **`auto` 不能被持久化**：在默认档里选「自动审查」等价于「清空已存默认值」，因此会**清掉之前存的具体预设**。这是宿主约束（见上），不是 bug。日常想保留具体默认档时，就别把默认设成自动审查。
- 停用/卸载插件后，默认值回落到 profile 组合里的默认档（通常是「工作区内修改」）。
- 重启 DSH 时，官方集成会把处于 `auto` 的旧会话按内置规则迁移；新会话仍按本插件/你的设置。
- 自动审查本身是实验性功能：每次工具调用都会多一次模型请求，可能误放行或误拒绝。

## 故障排查

插件会把运行情况写到 `<DSH_PROFILE_DIR>/auto-defaults-status.json`：

| 字段 | 含义 |
|---|---|
| `configuredDefault` | 插件实际读到的用户默认值（三级兜底结果）；为 `null` 表示没有任何已配置的默认值 |
| `describedDefault` | `settings.describe()` 用户层读到的值，用于对照 |
| `presetEntry` | 定位到的 Loader entry id |
| `publish` / `withdraw` | `auto` 是否已发布 |
| `lastWrite` / `lastWriteResult` / `lastWriteError` | 最近一次权限设置写入的入参与结果（`cleared: true` 表示把 `auto` 改写成了清空） |

常见判断：

- `configuredDefault` 有值但新会话不跟随 → 不是本插件的问题，检查该值是否被别的插件/补丁覆盖。
- `lastWriteError` 出现 `SettingsConflictError` → 客户端持有的 revision 过期，重新打开设置页再选一次。

## 变更记录

**1.3.0**

- 修复：默认值读取改为从 Loader entry 取值（三级兜底），不再依赖 `settings.describe()`。此前 settings 服务未就绪时读取静默失败，导致「设置里选的默认权限不生效、新会话始终回到自动审查」。
- 新增：写入链路诊断（`configuredDefault` / `describedDefault` / `lastWrite*`）。
- 文档：补充宿主四条硬约束与故障排查。

**1.2.0**

- 修复：`auto` 改为发布到服务**实例**而非宿主 live config，`cordis-plugin-loader` 的热更新路径不再被破坏，改权限不再触发整插件重启，从而消除 `gateway/service-unavailable: permissionPresets/catalog`。
- 修复：不再把 `defaultPreset: auto` 写入配置；写入被翻译为清空，并加 `internal/config` 兜底，避免下次启动权限服务挂载失败。
- 移除：挂载期延迟重试写设置的逻辑（不再需要，也不再依赖 HMR 事务逃逸）。

**1.0.0**

- 初始版本：把「自动审查」发布为可选默认档，并让新会话默认进入自动审查。

## English

`dsh-auto-review-default` makes the shipped experimental **Auto review** permission preset the effective new-session default in DeepSeek Harness, without ever writing into the host's live plugin config.

The host structurally keeps `auto` out of the settings list: that list is built from configured presets, `auto` is reserved for the review integration, and its own constructor resolves the configured default before that identity can exist — so a stored `auto` breaks the permission service on every later boot. The plugin therefore publishes `auto` onto the **service instance's** preset table (leaving `config.presets` untouched so the loader still applies settings edits as hot volatile updates), reads the user's configured default straight from the Loader entry, translates any `set defaultPreset=auto` write into clearing the field, and drops such a value in an `internal/config` guard as a last line of defence.

Install it into a profile that already loads `@deepseek-ai/dsh-experimental-auto-review`, restart DSH, then pick **自动审查 / Auto review** under Settings → General → Permission. Note that selecting Auto as the stored default clears any previously stored concrete preset — that is a host constraint, not a plugin choice.

## License

MIT