# BugDone → Multica Bridge

一个油猴脚本，在 BugDone 页面中读取 Bug 详情，将 Bug 创建为 Multica 任务并指派给智能体。支持 Mac App WebView 的 Fastlane 原生网络桥。

![BugDone 接入 Multica 的界面预览](./assets/ui-preview.png)

*界面预览使用本地模拟 Bug 和智能体数据。*

## 安装

1. 安装 [bugdone-multica.user.js](./bugdone-multica.user.js) 到 Tampermonkey，打开并登录 BugDone。
2. 打开某个 Bug 详情，点击右下角 **Multica-AI · 已启动**。
3. 在设置中填写 Multica API 地址、工作区 UUID、个人访问令牌（PAT），可选填写 Multica 项目 UUID；首次读取智能体后，列表和选择会保存在本地，下次打开自动恢复。
4. 核对可编辑的任务内容，勾选确认，点击 **提交**。

脚本会先查找同一 Bug 的已有任务，避免重复创建。新任务提交前，脚本会从 `img.bugdone.cn` 获取截图，上传到 Multica，再通过 `attachment_ids` 将截图关联到任务。图片读取或上传失败时会停止创建并显示原因。非图片附件目前只作为原始链接写入任务描述。

## Mac App WebView

没有 `GM_xmlhttpRequest` 时，脚本优先使用 `FastlaneNativeNetwork`。Mac App 需安装支持 `sourceUrl` 图片转传的新版原生网络桥，且脚本元数据必须包含 `@fastlane-network`、Multica API 主机和 `img.bugdone.cn` 的 `@connect` 声明。旧版 App 回退到网页 `fetch`，可能因 CORS 无法提交。

自建 Multica API 需要在脚本头部添加对应的 `@connect` 主机名，再重新安装或加载脚本。不要在仓库、截图或 Issue 中提交 PAT、Cookie 或 BugDone 私有数据。

## 本地检查

需要 Node.js，无第三方依赖：

```sh
npm run check
npm test
```

任务创建成功只表示已提交并指派；智能体的实际执行状态请到 Multica 查看。已创建任务不会因再次点击提交而重新触发。
