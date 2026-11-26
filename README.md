# 建站工作台

基于 Vue 3、Fastify、Node.js 和 SQLite 的对话式在线建站平台。

## 项目架构

- `src/`：Vue 3 前端工作台，包含对话、项目、预览和调研报告界面。
- `server/`：Fastify 后端与站点生成服务，包括模型调用、Agent、多 Agent 协作、预览沙箱、存储和分享预览。
- `deploy/`：Linux 部署所需的 Docker、systemd、启动器和权限配置。
- `test/`：构建、API、预览和生成流程测试。

前端负责编排用户交互和预览展示，后端负责对话生成、项目管理、文件合并、沙箱执行和访问控制。生成的站点运行在隔离预览环境中，并通过 SQLite 保存项目数据。

## 体验地址

https://aitishici.site/builder/
