# 多站点动态捕获与通用 AI 任务创建：需求和落地方案

> 状态：远期设计，尚未实施。基于 2026-10-23 的 BugDone → Multica Bridge v1.0.8 整理。本文的配置、模块名和阶段划分是方案，不代表用户已批准实现细节。友盟 API 路径、响应字段和日志下载能力尚未实测，文中不虚构它们。

## 1. 意图与范围

当前脚本只在 BugDone 页面运行：旁观 BugDone 的列表/详情响应，生成 Bug 任务草稿，在 Multica 查重、上传截图、创建并指派任务。目标是逐步变成一个“信息捕获 → AI 任务创建”的工作台：

1. 同一套任务创建、连接、处理列表和附件能力，可服务多个**明确配置过的网站**。
2. 每个网站有自己的页面识别、数据采集、标准化、标题/描述生成、查重键和可选后置动作规则。
3. 对未配置网站，用户也能手动选取当前页面的可见内容，编辑草稿后创建任务；不自动监听全网请求。
4. 第一栏成为“信息捕获”；第二栏“AI任务创建”显示最终真实标题和描述，提交时不暗中改写。处理列表和设置仍为通用能力。

用户提出的两个首批站点场景是 BugDone 和友盟 APM 崩溃分析。BugDone 当前行为必须平滑迁移；友盟需要从崩溃列表进入某条详情，捕获错误明细的详细日志、行为日志等上下文。`/error_analysis/crash` 和 `/error_analysis/crash/detail/:id` 是**页面入口**，不能当作数据接口；友盟真正的接口及响应结构需要通过实际页面会话验证。

### 本期不做

本文只固定需求、设计和实施步骤，不修改脚本、不启用跨站捕获、不猜测友盟 API。初期也不提供任意 JavaScript 插件执行、对任意网站自动提交、云端同步配置或自动抓取所有资源。

### 成功的样子

- 在 BugDone 打开某个 Bug，第一栏捕获完整详情并保留现有标题、查重和状态同步语义；第二栏仍可逐字编辑最终任务。
- 在经验证并启用的友盟配置下，打开崩溃详情，页面能显示来源、错误 ID、核心信息、错误明细和行为日志的捕获状态；长日志可作为 Multica 附件交付，任务描述有摘要和附件清单。
- 在未配置网页上，用户主动框选/选中文字或选取页面区域后能生成可编辑任务；没有稳定业务 ID 时只做本地草稿指纹提示，不声称已完成跨站强查重。
- 不同站点、应用/项目和记录之间不串数据；刷新、切换记录或网络响应乱序时能明确看到草稿属于哪个来源。

## 2. 现状与必须保留的行为

当前脚本在 `bugdone-multica.user.js` 中实现：

| 能力 | 现状 | 迁移要求 |
| --- | --- | --- |
| 捕获 | 只监听 `https://www.bugdone.cn/Service/BugDone/BugAPI.ashx` 的 XHR/fetch 成功响应；WebView 通过页面上下文桥转发 | 将监听器抽成通用传输层，规则仍必须先校验来源站点、URL、方法和响应大小 |
| 数据 | `parseResponse()` 区分 `ReturnObj.ItemList` 列表与单条详情，`mergeBug()` 防止列表空字段覆盖详情 | 标准化后保留详情优先、字段来源、时间和完整度 |
| 草稿 | BugDone 生成 `[BugDone] #编号 … [BugDone:<BugId>]`，第二栏标题/描述原样提交 | 标题模板和查重标记由捕获配置生成，通用任务页不得二次格式化 |
| 查重 | 本地任务 ID 核验 → Multica 搜索标记 → 确认不存在后创建；不确定结果保留 `pending` | 升级后旧 BugDone 标记继续识别；新站点使用稳定源键和同样的谨慎流程 |
| 附件 | BugDone 截图上传 `/api/upload-file`，创建请求带 `attachment_ids`；非图片仍是原始链接 | 统一附件清单和上传状态；本地文件、日志与图片都应走真正附件关联 |
| 后置动作 | 新建成功后，对仍为“待处理”的 BugDone Bug 调原站点接口改“处理中” | 仅作为 BugDone 专属、显式启用的动作；其他站点默认无写操作 |
| 环境 | 油猴 `GM_xmlhttpRequest` / Fastlane 原生网络桥 / 网页 `fetch` | 明确运行环境能力；不能把可用网络能力当作默认具有跨站权限 |

现有脚本顶部 `@match` 和原生桥 `@connect` 是**安装时权限**。配置新增站点或资源域名，不能自动扩张这些权限。首批上线时应通过明确列出的站点元数据发布新版脚本；“任意网页手动选取”如采用全站注入，必须另行设计授权入口、宿主权限及默认关闭策略。

## 3. 用户体验与状态

### 3.1 信息捕获（第一栏）

顶部显示当前匹配的站点配置、页面类型、捕获方式和时间，例如“BugDone · 详情 · 接口响应 · 14:32”。列表页展示可选择的条目，详情页展示当前条目；切换条目不混合不同 ID 的数据。字段预览至少包括标题、来源页面 URL、只读分享 URL（若站点提供）、业务 ID、正文摘要和附件/日志清单。每项说明“已捕获 / 未提供 / 正在加载 / 失败 / 需手动补充”，不要把缺失误写成空值。

用户可编辑由捕获生成的标题和描述；“重新生成”需提示会覆盖手工编辑。固定底部按钮“下一步：AI任务创建”把当下草稿快照送入第二栏。若源记录发生变化而第二栏有未提交编辑，先提示“来源已变化，是否用新捕获内容替换”，不静默覆盖。

### 3.2 通用 AI 任务创建（第二栏）

显示最终标题、最终描述、来源和可管理的附件 item；项目、智能体、状态、优先级、标签、日期仍可选。用户在此处的编辑即提交值。来源键/查重键作为只读元数据另存，不能只依赖可删除的标题文本；为了兼容旧任务，BugDone 旧标题标记仍可参与搜索。创建前给出目标工作区、附件数量和查重结果。复用已有任务与新建成功有不同提示，不能自动把新附件附到复用任务上。

### 3.3 处理列表与设置

处理列表记录 `siteId + scopeId + recordId`、Multica 工作区/任务 ID、来源 URL、提交时间和状态；最多 100 条，新增第 101 条淘汰最旧本地记录，不影响 Multica 任务。删除 item 只删除本地记录。设置增加“站点捕获配置”入口：查看内置配置版本、开关、站点权限、导入/导出、校验结果和测试预览。API Token、Cookie 不进入可导出站点配置。

### 3.4 任意网页手动模式

由用户明确点击“从当前页面选取”，进入选择文字或 DOM 区块模式，显示将读取的文本与链接预览；允许取消、删减、补充。仅采集用户选中的**可见**内容及当前 URL，不读取密码输入、隐藏元素、同源外 iframe、整页脚本状态或后台请求。没有页面稳定 ID 时以 URL 规范化值和内容指纹提示“可能重复”，但必须让用户核对，不能当成可靠的任务唯一键。

### 3.5 站点配置界面

设置页的“站点捕获配置”先列出每个 profile 的名称、版本、启用状态、允许的域名、上次校验结果。打开某个 profile 后分步编辑：① 页面入口（列表/详情路由）；② 网络响应规则或可见 DOM 规则；③ 记录 ID 与字段提取；④ 标题/描述/查重模板；⑤ 附件与后置动作。每一步都有说明、精确匹配预览和“此规则会读取什么数据”的提示。内置 BugDone 配置默认只读；需要调整时复制为用户配置，不覆盖内置版本。友盟配置在真实接口验证前保持停用。

导入 JSON 后先展示 schema 错误、将新增的域名、请求观察范围与当前版本的差异；只有通过校验且用户主动启用才进入运行时。提供脱敏样本试运行：输入列表或详情响应后显示识别到的条目数、字段、缺失项、生成标题/描述和查重键，不实际调用 Multica 或源站写接口。规则诊断只记录规则 ID、命中次数、解析结果与错误类别，不存响应正文、Token 或日志。用户可导出配置、停用或恢复内置版本；配置更新失败自动保留上一份可用版本。

## 4. 配置模型：页面、接口和字段分开

“页面规则”回答脚本何时在什么页面工作；“网络规则”回答哪个响应值得读取；“提取规则”回答如何从响应或可见 DOM 得到字段。这三者不能合并成一个 URL 正则。

每个 `siteProfile` 至少有：`id`、`version`、`enabled`、`allowedOrigins`、`pages`、`captures`、`record`、`draft`、`dedup`、`attachments`、`postActions`。配置只接受声明式白名单字段：URL 模式、JSON 路径、有限字符串模板和内建变换。**不接受 `eval`、配置中的任意 JS、请求头/Cookie 模板或自动执行任意 POST。**用户自建规则先在只读预览中验证，再手动启用。

下面是**建议配置形状**。YAML 只用于阅读示例；首版实际持久化与导入/导出格式定为 JSON，并用版本化 schema 校验，不引入 YAML 解析依赖。BugDone 的接口与字段来自现有脚本；友盟 `captures` 暂为空，表示尚未完成接口发现，不是可直接启用的配置。

```yaml
schemaVersion: 1
profiles:
  - id: bugdone
    version: 1
    enabled: true
    allowedOrigins: ["https://www.bugdone.cn"]
    pages:
      - kind: list
        path: "/cn/bugManagement_*"   # 页面路由；不是数据接口
      - kind: detail
        path: "/cn/bugManagement_*"   # 详情可能是同页弹层
    captures:
      - id: bug-api
        transport: [xhr, fetch]
        method: POST
        origin: "https://www.bugdone.cn"
        pathCaseInsensitive: "/Service/BugDone/BugAPI.ashx"
        contentType: json
        maxResponseBytes: 4000000
        variants:
          - kind: list
            when: "$.ReturnObj.ItemList is array"
            items: "$.ReturnObj.ItemList[*]"
          - kind: detail
            when: "$.ReturnObj.BugId exists"
            item: "$.ReturnObj"
    record:
      scopeId: "$.ProjectId"
      recordId: "$.BugId"
      title: "$.BugTitle"
      number: "$.BugCode"
      descriptionHtml: "$.Description"
      attachments: "$.BugAccessoryList[*]"
      detailWinsOverList: true
    draft:
      titleTemplate: "[BugDone] #{{number}} {{title}} [BugDone:{{recordId}}]"
      descriptionTemplate: "bugdone-v1"  # 内建格式器 ID，不执行模板代码
      shareUrlTemplate: "https://www.bugdone.cn/cn/bugPreview/{{scopeId}}/{{recordId}}"
    dedup:
      keyTemplate: "bugdone:{{scopeId}}:{{recordId}}"
      legacyTitleMarker: "[BugDone:{{recordId}}]"
      policy: verify-local-then-search-before-create
    attachments:
      images: upload-and-link
      otherFiles: show-source-link-until-supported
    postActions:
      - id: bugdone-start-processing
        enabled: true
        trigger: newly-created-only
        precondition: "status == 待处理"

  - id: umeng-apm-crash
    version: 0
    enabled: false               # 实际接口及字段验证前不得启用自动捕获
    allowedOrigins: ["https://apm.umeng.com"]
    pages:
      - kind: list
        path: "/platform/:appId/error_analysis/crash"
      - kind: detail
        path: "/platform/:appId/error_analysis/crash/detail/:errorId"
        queryIdentity: ["errorId"]
        ignoreQueryForIdentity: ["startDay", "endDay", "version", "dateRange", "orderBy", "order"]
    captures: []                  # 待实测补齐：列表、详情、错误明细、行为日志
    record:
      scopeId: ":appId"
      recordId: ":errorId"
      detailWinsOverList: true
    draft:
      titleTemplate: "[友盟崩溃] {{title}} [UmengCrash:{{scopeId}}:{{recordId}}]"
      descriptionTemplate: "umeng-crash-v1"
    dedup:
      keyTemplate: "umeng-apm-crash:{{scopeId}}:{{recordId}}"
      policy: verify-local-then-search-before-create
    attachments:
      errorLog: prefer-file-if-long
      behaviorLog: prefer-file-if-long
    postActions: []
```

上述 `path` 的 `*` 和 `:param` 是**建议 DSL**，实现时必须定义转义、大小写、路径边界与优先级，不直接拼接未转义正则。`when` 也是有限条件语法示意，真正实现应由固定谓词（例如 `hasKey`、`isArray`）表达。BugDone 页面是否需要更精确的路由匹配，要以实际导航和弹层行为确认；当前可靠边界仍是同源 BugAPI 响应。

友盟配置里 `:appId`、`:errorId` 只是从给定详情 URL 的路径看出的候选标识；实现时必须比对详情响应中的应用与错误标识，发现不一致就停止自动合并。日期范围、版本等筛选参数描述**观察上下文**，不默认进入查重键；同一错误在不同筛选下仍是同一条崩溃记录。若业务发现“同 ID 在不同维度代表不同问题”，需调整 `scopeId` 或加入额外稳定维度，并迁移旧键。

### 4.1 从列表到详情的归并

标准记录使用 `{siteId, scopeId, recordId}` 作为键。列表响应可创建摘要；详情响应只更新匹配键的记录。日志响应还需用页面路由、请求关联参数或响应中的错误 ID 绑定到该记录；绑定不确定时放入“待关联数据”，不得猜测属于当前选中的 item。每个字段保存 `value`、`source`、`capturedAt`、`completeness`；只有明确“详情比列表更完整”的字段才允许覆盖，空字符串不能抹掉已捕获详情。页面切换后晚到的响应不能污染新记录。

### 4.2 友盟接口发现与配置补齐

需要在已登录的 Ego Lite 或用户同意的浏览器会话中，分别观察：列表首次加载、打开一个详情、展开“错误明细”、切换/展开“行为日志”、翻页与筛选、复制或下载日志。记录每一步的**请求方法、URL、请求中稳定的关联字段、响应结构和大小**，不保存 Cookie/Token 或真实日志到仓库。对照两个不同错误 ID，确定哪个响应字段能可靠关联。若日志只在 DOM 中呈现，则配置 `dom` 规则，并证明虚拟列表/懒加载下可取得完整内容；若接口支持分页，必须抓取页数和截断状态。验证后才把 `captures` 从空数组补成准确的接口规则与 JSON 路径，并将配置版本提升到 1。

可在验证后补入类似下列规则，但 `origin/path/fields` 必须来自实际观察，不能照抄占位符：

```yaml
# 占位结构，不是友盟真实接口
- id: umeng-behavior-log
  transport: [xhr, fetch]
  method: GET
  origin: "https://apm.umeng.com"
  path: "<实测后的精确接口路径>"
  bindRecordBy: "<实测后的响应或请求字段>"
  items: "<实测后的日志数组路径>"
  pagination: "<无 / 实测后的页码规则>"
```

## 5. 标准数据与草稿生成

内层模型不使用 BugDone 字段名：

```text
CapturedRecord {
  siteId, scopeId, recordId, pageKind, sourceUrl, shareUrl?,
  title, number?, summary?, descriptionBlocks[], environment?, severity?,
  attachments[], logs[], tags[], fieldSources, capturedAt, completeness
}
TaskDraft {
  sourceKey?, title, description, attachments[],
  workspaceId?, projectId?, agentId?, status?, priority?, labelIds?, dates?
}
```

捕获层负责从站点数据生成 `TaskDraft`。标题模板、描述段落顺序、查重标记、来源链接、日志摘要都在第一栏生成并可预览；第二栏只接受快照并保留编辑。模板缺少必填字段时展示缺失提示，不生成带 `undefined` 的标题。HTML 转文本要剔除脚本、隐藏/敏感字段，Markdown 链接要转义，URL 只允许经校验的协议和来源。日志的时间、线程、设备、版本、栈和行为顺序尽可能保留；长度上限由配置和附件策略决定，不静默截断。

配置可选择性定义 `taskDefaults`：从站点严重级别映射 Multica 优先级、设定初始状态或标签。未匹配的站点取值只保留在描述里，使用用户在设置页选定的默认值；不把未知严重级别猜成“紧急”。工作区、项目和智能体优先取用户当前选择，站点配置不得嵌入个人 Token 或强行覆盖用户在第二栏的最终选择。

对友盟，建议任务描述保留：崩溃摘要、发生环境、关键栈顶部、错误明细摘要、行为日志摘要、来源详情 URL、筛选时间范围，以及“完整日志见附件”的明确列表。完整长日志生成 `.txt`/`.json` 文件上传到 Multica；短日志可以直接内嵌描述。阈值属于方案默认值，初版建议每段约 20 KiB，实际阈值要按 Multica 与智能体的上下文限制验证。用户可在提交前删减敏感日志片段。

## 6. 查重、附件与提交事务

### 6.1 查重规则进入配置，但算法统一

`dedup.keyTemplate` 产生稳定 `sourceKey`。同一个站点不同应用/项目 ID 不冲突；页面日期和筛选参数通常不加入键。任务保存 `sourceKey` 的可搜索标记；BugDone 同时兼容旧 `[BugDone:<BugId>]`。通用提交流程是：

1. 校验草稿的来源键、目标工作区和必填字段；对无稳定来源键的手动草稿只提示可能重复。
2. 按 `api + workspace + sourceKey` 查本地关联任务 ID，并向 Multica 核验其身份。
3. 未命中时在 Multica 搜索相同标记，分页、精确核对来源键；搜索失败、身份冲突或上次结果未确认时停止，避免盲目重复创建。
4. 确认没有已有任务后才上传选中的附件；汇总 `attachment_ids`，创建任务并指派智能体。
5. 仅在得到明确成功响应后记录任务 ID，执行站点专属后置动作。网络超时或 5xx 保留“待确认”，下次先核验，不重发创建请求。

复用已有任务时只展示现有任务，不默认上传新附件或修改原任务。若未来提供“补充到已有任务”，应作为独立、明确的用户操作，调用 Multica 更新任务的附件关联能力，并处理权限与冲突。

### 6.2 附件是真关联，URL 仅供预览

统一附件 item 包含 `id`、`origin`（站点/本地）、`name`、`mime`、`size`、`sourceUrl?`、`file?`、`selected`、`uploadState`、`multicaAttachmentId?`。回形针打开本地文件选择器；捕获的图片/文件与手选文件一并显示为可移除 item，包含来源、类型和大小。**提交前的移除**只从待提交清单移除，不删除源站文件。上传在查重后发生；成功返回的附件 ID 用 `attachment_ids` 关联新任务。上传失败时不创建任务，列出失败项；已上传但未关联的暂存文件需记录 ID，并在权限允许时清理或提示人工核对。

描述中的原始外链不能替代关联附件：智能体可能无法访问私有链接，签名 URL 可能过期。任务描述可保留可读的附件名称和来源链接，但“完整文件可供智能体读取”以 Multica 附件关联为准。Multica 源码提供 [`POST /api/upload-file`、上传时可用的 `issue_id` 和 `DELETE /api/attachments/{id}`](https://github.com/multica-ai/multica/blob/main/server/internal/handler/file.go)，[创建任务接受 `attachment_ids`](https://github.com/multica-ai/multica/blob/main/server/internal/handler/issue.go)；删除接口有上传者/管理员权限限制。具体部署版本仍须联调。

Mac WebView 当前原生桥的通用请求体限 1 MiB，`sourceUrl` 转传只适合外链图片。要可靠上传用户选取的任意本地文件，需要为原生桥新增**通用流式/分块文件传输**，由页面仅提交用户主动选择的 File 数据，原生侧写入临时文件并上传；不得让网页传任意本地绝对路径。油猴环境可用受控 `FormData` 上传。两种环境的结果与错误状态必须一致。

## 7. 运行环境与安全边界

- 捕获开关按站点关闭优先。只对当前 `allowedOrigins` 和精确网络规则做旁观监听；限制响应体大小、MIME 和解析耗时。不读取/记录 Authorization、Cookie、密码字段或无关请求体。
- 主世界桥向脚本世界传输前验证消息来源、nonce、规则 ID 和大小；不能仅靠可伪造的固定布尔标记。必要时把提取放在同一上下文并只传最小标准字段。
- 自定义配置的 URL 模板只生成源站只读链接，不作为任意网络请求入口。附件 URL 校验协议、主机与重定向；跨域请求仍受油猴 `@connect` 或 Mac 原生桥的明确主机许可约束。
- 站点配置与用户 Token 分开存储。导出文件默认不含 Token、Cookie、真实 Bug/崩溃正文、日志和本地附件。导入先 schema 校验、展示权限变化与差异，再启用。
- 手动模式只由用户动作触发；不在所有网页自动装配捕获规则。iframe、虚拟列表、Shadow DOM 和动态单页路由各有明确的“仅抓已加载可见内容”提示。
- 配置版本变更支持迁移与回退。旧 BugDone 本地提交列表和旧标题标记持续可查询；不把旧数据误识别为新站点记录。

## 8. 建议模块边界

实施时可从单文件脚本构建出一个仍可发布为单个 `.user.js` 的源码结构；不要求引入框架。

| 模块 | 责任 | 不做什么 |
| --- | --- | --- |
| `site-registry` / `profile-validator` | 读取、版本化、校验和选择站点配置 | 不执行配置里的代码 |
| `capture-runtime` | 路由观察、XHR/fetch 桥、DOM/手动选择适配 | 不写任务、不保存令牌 |
| `record-normalizer` | 根据 `{siteId, scopeId, recordId}` 归并字段、日志和附件 | 不生成最终任务 |
| `draft-builder` | 模板、来源标记、描述结构、编辑快照 | 不偷偷修改第二栏编辑结果 |
| `multica-client` / `submit-service` | 连接、查重、附件上传、创建、恢复 | 不关心 BugDone/友盟字段名 |
| `site-actions` | 经许可的站点特有后置动作 | 不在通用提交流程里硬编码站点写接口 |
| `ui` / `storage` | 四栏工作台、配置、处理列表与本地记录 | 不解析站点私有 API |

建议文件组织（实施时可按构建工具调整）：`src/capture/`、`src/profiles/bugdone/`、`src/profiles/umeng/`、`src/task/`、`src/ui/`、`test/fixtures/`，输出仍是仓库根目录的 `bugdone-multica.user.js`。每个 profile 配小型**脱敏或合成**响应样本；真实用户日志和截图不得进入测试夹具、README 或仓库。

## 9. 分阶段实施与可验收交付

每阶段独立发布、可回滚；先保证 BugDone 不退化，再增加新站点。阶段中的配置模板、阈值和文件拆分是本文建议，实施时如发现现网 API 差异需更新本文。

| 阶段 | 实施步骤 | 可验收目标 |
| --- | --- | --- |
| 0. 基线与样本 | 固定现有 BugDone 列表/详情、查重、上传和 WebView 的脱敏夹具；记录现有 UI/网络行为 | 旧 BugDone 流程在 Tampermonkey 与 WebView 均可回归；不含隐私数据 |
| 1. 捕获抽象 | 定义 schema 与校验器；分离路由规则、网络匹配、标准记录、草稿生成；将 BugDone 迁入内置 profile | 同一 Bug 的列表→详情归并、旧标题标记、复用任务及状态同步均不变；未知站点无自动捕获 |
| 2. 通用 UI 与权限 | 第一栏改“信息捕获”；增加 profile 状态、配置管理、草稿快照；先在已配置站点提供手动选取 | BugDone 正常；已配置站点的手动选取仅在用户动作后读取可见内容；切换来源不覆盖编辑 |
| 3. 附件统一 | 做附件 item、选择/移除、上传队列；扩展 Fastlane 原生桥的本地文件传输；整理失败清理 | 图片、普通文件、日志在油猴和 Mac App 都能以 `attachment_ids` 关联；移除项不上传；查重命中不上传 |
| 4. 友盟接口验证 | 在实际登录会话观察列表、详情、错误明细、行为日志和分页；整理合成夹具，填实配置 | 两个不同错误 ID 的数据不串；长日志完整度可见；接口失效时明确降级为手动捕获 |
| 5. 友盟上线 | 启用友盟 profile、描述/日志格式器、查重键，补状态和联调 | 从友盟详情创建任务，Multica 智能体可读取完整日志附件；重复点击不重复创建 |
| 6. 可配置扩展与任意网页手动模式 | 安全导入/导出、只读试运行、规则诊断、配置迁移；发布全站轻量入口和手动选取 | 新增第三个站点时无需改通用捕获和提交核心；未配置网页无自动监听，仅用户手动选取可见内容；权限增量与隐私范围对用户可见 |

关键测试矩阵：XHR/fetch 两种来源、主世界/隔离世界、列表详情乱序、同 ID 跨项目、日志分页与截断、长文本/恶意 HTML、外链重定向、附件上传部分失败、任务创建超时、旧记录迁移、站点配置禁用、全局手动模式误触发。单元测试用合成数据；浏览器回归优先用 Ego Lite 在用户授权的已登录页面验证，Mac App 另需真实 WebView 构建验证。

## 10. 需要在实施前验证的事实与决策

1. **友盟接口事实**：列表、详情、错误明细、行为日志的真实接口、鉴权方式、分页、大小与稳定记录 ID。未验证前不发布自动友盟配置。
2. **日志交付阈值**：约 20 KiB 的“内嵌/附件”切换值只是建议；需结合实际日志量和智能体读取能力调整。无论阈值如何都必须显示截断状态。
3. **全站手动入口的实施决定**：首版同时覆盖 Tampermonkey 与 Mac App WebView，沿用同一个用户脚本发布物。阶段 6 使用显式的 HTTPS 全站匹配元数据提供**轻量入口**，但未配置网站绝不安装 XHR/fetch 观察器；用户点击“从当前页面选取”后才读取当时可见内容。Mac App 仍用现有用户脚本宿主加载，针对其匹配语法单独验证；不把原生菜单或独立扩展设为首版依赖。这是本文提出的实现选择，不是用户已经确认的授权；发布前需让用户看到全站权限变化，且提供关闭全站入口的设置。
4. **配置编辑范围**：首版推荐内置 profile + JSON/YAML 导入与表单预览，不让配置执行脚本代码。若需更复杂的站点适配，应作为经审查的版本化适配器发布。
5. **Multica 部署差异**：联调确认上传、任务创建、任务更新和附件删除 API 在官方/自建服务上的实际行为及权限；API 不可用时必须保持清楚的降级提示。

这些条目不会阻止阶段 0–1 的实施，但会阻止相应后续阶段声称完成。
