# v0.10.3 — 查找与分发 / Discovery and distribution

- GitHub About 改为中英双语，并提供软件、MCP、FPGA/EDA 等相关主题。
  Bilingual GitHub About with relevant MAX+plus II, MCP, FPGA and EDA topics.
- 中文、英文首页增加软件名称别名、官方目录身份及查找和连接说明。
  Both introductions include software name variants, registry identity and a discovery guide.
- 新增标准 MCPB 清单与安装包。客户端可选择软件目录和工程目录；无需 npm 依赖。
  Standard MCPB manifest and bundle with local directory selection; no npm dependencies.
- 打包脚本从已提交源码生成 MCPB、含真实 SHA-256 的官方目录 `server.json` 和校验文件。
  Packaging generates an MCPB, registry `server.json` with its actual SHA-256, and checksums from committed source.
- 提供 `llms.txt` 项目入口，指向实际能力、限制和验证文档。
  `llms.txt` links agents to capabilities, limits and verification evidence.

核心 68 个 MCP 工具的行为保持与 v0.10.2 一致。目录收录不等于自动安装；网页搜索
和第三方目录的收录时间取决于各自服务。MCPB 需要支持该格式的 Windows 客户端。

The 68 MCP tools retain v0.10.2 behavior. Registry discovery does not install the
server. Web indexing and downstream catalog synchronization depend on each service.
The MCPB requires a Windows client supporting that format.
