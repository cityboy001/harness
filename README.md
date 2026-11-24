# 建站工作台

用 Vue 3、Fastify、Node.js 24 和 SQLite 实现的对话式在线建站工具。工作区提供私有全栈预览和只读源码。

## 本地运行

需要 Node.js 24.15 或更新的 Node.js 24 LTS。

1. 运行 `npm ci`。
2. 复制 `.env.example` 为 `.env`，填入 `DEEPSEEK_API_KEY`。也可以登录后在模型设置中保存自己的兼容接口。将 `BUILDER_DEMO=1` 写入 `.env` 后，可以选用固定的待办演示测试流程。
3. 运行 `npm run dev` 并打开 [本地工作台](http://localhost:3000/)。
4. 运行 `npm test` 验证构建后的 API 和预览工作流。前端类型检查使用 `npx vue-tsc --noEmit`。

首次生成返回完整站点，后续修改先向模型提供文件清单，再按需提供它请求的源码。平台校验新增、替换和删除的文件，合并成候选版本后交给沙箱。对话区可展开查看 DeepSeek 返回的思考文字，生成期间会持续更新。

启用浏览器测试的环境使用 LangGraph 为复杂全栈需求编排任务。中央 Agent 制定接口和验收步骤，前后端 Agent 并行提交增量改动，平台合并后运行浏览器验收。失败可派回修复最多 2 轮，整轮编排最多运行 16 分钟。普通问答和单层小改动使用原来的生成流程。

每个项目的原始对话保存在 `messages`，移出最近四轮的内容会分批提炼到 `project_memory` 滚动摘要。中央 Agent 可以按短语或对话 ID 查同项目的原始记录；前后端 Agent 接收各自相关的项目约定和共享接口。

本地预览在独立 Node 子进程的 QuickJS WebAssembly 沙箱中执行，应用数据默认放在 `.builder-data`。生成的网页在无同源权限的 iframe 中渲染，项目 API 经工作区转发并检查会话和项目归属。

生成网站后可以通过「分享预览」创建 24 小时有效的访客链接。链接固定展示创建时的版本，创建新版链接会替换旧链接，也可以手动撤销。访客沙箱使用独立的 SQLite 数据，链接不会暴露工作区、后端源码或项目原有的数据库记录。

## Linux 部署

服务器部署目录为 `/srv/ai-site-builder`。HTTPS 模式要求配置 gVisor 启动器。使用 `deploy/` 里的固定镜像、启动器、sudoers 和 systemd 单元。应用监听回环地址，由现有 HTTPS 网关代理到应用的 `BASE_PATH`。项目数据保存在 `DATA_DIR` 下。生成的项目后端运行于禁网的 gVisor 容器，每个运行版本仅挂载它自己的 SQLite 目录。

腾讯云部署入口为 [线上工作台](https://aitishici.site/builder/)。环境配置在 `/etc/ai-site-builder/app.env`。用 `sudo systemctl restart ai-site-builder` 加载修改后的环境。

将 `PLATFORM_USER_DAILY_LIMIT`、`PLATFORM_DAILY_LIMIT` 或 `CUSTOM_USER_DAILY_LIMIT` 设为 0，可以关闭对应的每日次数限制。

DeepSeek 的单个生成任务默认使用 `DEEPSEEK_MAX_TOKENS=32000`，思考、工具调用和最终输出共用这个预算。其他兼容接口使用 `MODEL_MAX_TOKENS`。

设置 `BROWSER_TEST_LAUNCHER=/usr/local/sbin/ai-site-builder-browser-test` 可启用 DeepSeek 的浏览器测试工具。先用 `deploy/Dockerfile.browser` 构建 `ai-site-builder-browser:1`，再安装启动脚本和对应 sudoers 规则。每次测试都在禁网的临时 Chromium 容器中运行，使用独立的测试数据库。

`ai-site-builder-backup.timer` 每天在 `/var/backups/ai-site-builder` 保存平台库、活动项目库和本地 Key 加密密钥的一致性备份，保留七天。恢复时先停止服务，并将选定快照恢复为 `/var/lib/ai-site-builder` 中的对应文件，设置所属用户为 `ai-site-builder`。如果用环境变量 `CREDENTIAL_KEY` 加密，恢复时应保留该环境变量。腾讯云 COS 异地备份需要另行配置。
