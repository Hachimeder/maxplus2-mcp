# v0.10.2 / 发行说明 / Release notes

[简体中文介绍](../README.md) | [English introduction](../README.en.md)

## 简体中文

本次更新补齐下载发行包及两种语言的完整介绍页面。MCP 工具仍为 68 个。

- `maxplus2-mcp-v0.10.2.zip`：精简发行包，包含运行源码、独立 Windows 后端源码、
  配置示例、中文/英文 README 及操作文档。解压后通过 Node.js 启动，无需 Git
  或 npm install；原厂编译与界面功能仍需另行安装 MAX+plus II。
- `maxplus2-mcp-v0.10.2-source.zip`：完整公开源码，另含测试、开发脚本及 CI 模板。
- `SHA256SUMS.txt`：两个下载包的 SHA-256 校验值。

新增 `scripts/package-release.mjs` 从明确的公开 Git 提交生成两个包，排除本机
配置、构建输出、日志、截图和私人资料。中英文介绍互相链接，并覆盖能力、
安装、客户端配置、操作顺序、验证、限制和许可。

## English

This update adds downloadable runtime packaging and complete Chinese/English
introduction pages. The MCP still exposes 68 tools.

- `maxplus2-mcp-v0.10.2.zip`: compact runtime package with runtime source,
  standalone Windows backend source, example configuration, both README pages
  and operating guides. Extract and launch with Node.js; Git and npm install
  are not required. Original compilation and desktop features still require a
  separately installed MAX+plus II environment.
- `maxplus2-mcp-v0.10.2-source.zip`: complete public source, also containing tests,
  development scripts and an inactive CI template.
- `SHA256SUMS.txt`: SHA-256 checksums for both packages.

The new `scripts/package-release.mjs` builds both packages from an explicit public
Git commit, excluding local configuration, build output, logs, screenshots and
private data. The two README pages link to each other and cover capabilities,
installation, client configuration, workflow, verification, limitations and licensing.
