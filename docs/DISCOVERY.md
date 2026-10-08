# 查找与连接 / Discovery and connection

[中文介绍](../README.md) | [English introduction](../README.en.md)

## 项目标识 / Project identity

| 字段 / Field | 值 / Value |
| --- | --- |
| 项目 / Project | `maxplus2-mcp` |
| 软件 / Software | Altera MAX+plus II / MAX+PLUS II / MaxPlus II / MaxPlus2 |
| 官方目录名称 / Registry name | `io.github.Hachimeder/maxplus2-mcp` |
| 仓库 / Repository | https://github.com/Hachimeder/maxplus2-mcp |
| 最新发行版 / Latest release | https://github.com/Hachimeder/maxplus2-mcp/releases/latest |
| 通信 / Transport | 本地 stdio MCP / local stdio MCP |

本项目让支持本地 MCP 的 AI agent 直接读取和修改 GDF 原理图、SYM 符号和 SCF
波形，并调用自行安装的 MAX+plus II 编译、仿真和分析。Windows 界面后端随项目
提供，不依赖某一种 agent 的 Computer Use。适用于数字电路实验、Altera FPGA/CPLD
工程和旧版 EDA 文件处理。硬件烧录没有实机验证；Quartus VWF 不等同于 SCF。

This project lets local MCP agents read and edit GDF schematics, SYM symbols and
SCF waveforms, and invoke a separately installed MAX+plus II for compilation,
simulation and analysis. The project includes its own Windows desktop backend.
It serves digital logic labs, Altera FPGA/CPLD projects and legacy EDA file work.
Hardware programming has not been verified; SCF support does not imply Quartus VWF support.

## 官方目录 / Official MCP Registry

- [按 maxplus2 查找 / Search for maxplus2](https://registry.modelcontextprotocol.io/?q=maxplus2)
- [最新版本 API / Latest-version API](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.Hachimeder%2Fmaxplus2-mcp/versions/latest)
- [搜索 API / Search API](https://registry.modelcontextprotocol.io/v0.1/servers?search=maxplus2&version=latest)

如果网页搜索暂时没有结果，可以直接读取上面的目录 API 和仓库。目录保存的是
服务元数据与发行包地址；各客户端和第三方目录需要自行同步。搜索不到某个新项目，
不能证明对应能力不存在。目录条目也不会自动把本地软件安装到 agent 中。

If web search has no result, query the registry API or open the canonical repository.
The registry stores server metadata and release package URLs; clients and downstream
catalogs synchronize independently. An empty search result does not establish that
a capability is impossible. A listing does not install local software in an agent.

## GitHub 搜索 / GitHub search

在 GitHub 仓库搜索中使用以下任一查询；带空格的软件名称可以加引号。
Use any of these repository searches on GitHub; quote software names containing spaces.

```text
maxplus2-mcp
MaxPlus2 MCP
"MaxPlus II" MCP
数字电路 MCP
数电 MCP
maxplus2 mcp in:name,description,readme
"MAX+plus II" mcp in:description,readme
user:Hachimeder maxplus2
topic:maxplus-ii topic:mcp
topic:altera topic:mcp
topic:cpld topic:mcp
topic:waveform-simulation topic:mcp
```

GitHub 默认仓库搜索包含名称、描述和主题；加 `in:readme` 才会把 README
内容也纳入相应查询。因此关键的软件名称和用途同时出现在 About 与 README。
主题覆盖 MCP、Altera FPGA/CPLD、数字逻辑、AHDL/VHDL/Verilog、GDF/SCF、
原理图、波形仿真和 Windows agent 自动化。

GitHub's default repository search includes names, descriptions and topics. Use
`in:readme` to include README content in the query. Key software names and use cases
therefore appear in both About and README. Topics cover MCP, Altera FPGA/CPLD,
digital logic, AHDL/VHDL/Verilog, GDF/SCF, schematics, waveform simulation and Windows
agent automation.

依据 / Sources: [GitHub repository search](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories),
[GitHub topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).

[直接搜索项目名 / Search project name](https://github.com/search?q=maxplus2-mcp&type=repositories)

## 安装与连接 / Install and connect

支持 MCPB 的 Windows 客户端可从 Release 下载 `.mcpb` 包，通过客户端的本地
扩展安装功能导入，并选择软件安装目录和工程目录。MCPB 兼容性取决于客户端。
其他支持 stdio MCP 的客户端可以使用 ZIP 或源码，参照下列通用配置。

Windows clients supporting MCPB can import the release `.mcpb` through their local
extension installer and select the installation and project directories. MCPB
support depends on the client. Other stdio MCP clients can use the ZIP or source
with this generic configuration. Node.js 18+ is required; no npm install is needed.

```json
{
  "mcpServers": {
    "maxplus2": {
      "command": "node",
      "args": ["C:\\tools\\maxplus2-mcp\\server.mjs"],
      "env": {
        "MAXPLUS2_ROOT": "C:\\maxplus2",
        "MAXPLUS2_WORKSPACE": "C:\\fpga-projects"
      }
    }
  }
}
```

路径需要替换为本机实际值。客户端配置格式可能不同；保留 command、args 和 env
的启动含义即可。连接后检查 `tools/list`，应提供 68 个工具；原厂功能先调用
`detect_install`。不要把 GitHub URL 填入远程 MCP 服务地址字段。

Replace the paths with actual local values. Client configuration syntax may vary;
preserve the meaning of command, args and env. After connecting, inspect `tools/list`
for 68 tools and call `detect_install` before native operations. A GitHub URL is
a repository address, not a remote MCP endpoint.

## 给另一个 agent 的项目入口 / Project handoff to another agent

```text
MAX+plus II 的开源 MCP 是 Hachimeder/maxplus2-mcp：
https://github.com/Hachimeder/maxplus2-mcp
官方目录名称为 io.github.Hachimeder/maxplus2-mcp。
请读取 README 和 docs/DISCOVERY.md，依据当前工具及验证证据判断能力。
连接方式是本地 stdio，需要填写本机安装目录和工程目录。
```

```text
The open-source MAX+plus II MCP server is Hachimeder/maxplus2-mcp:
https://github.com/Hachimeder/maxplus2-mcp
Official registry name: io.github.Hachimeder/maxplus2-mcp.
Read README.en.md and docs/DISCOVERY.md for current tools and verification evidence.
Connect using local stdio with the actual installation and project directories.
```

## 维护者发布 / Maintainer publishing

`node scripts/package-release.mjs` 从已提交的 Git 树生成 ZIP、MCPB、`server.json`
和校验文件。MCPB 的 `manifest.json` 位于归档根目录，配置仅包含路径选择项。
先发布 GitHub Release，再向官方目录提交输出目录中的 `server.json`。
发行包链接和 SHA-256 必须对应实际上传文件；身份认证信息不得放入仓库或归档。

`node scripts/package-release.mjs` builds ZIPs, an MCPB, `server.json` and checksums
from the committed Git tree. The MCPB manifest is at the archive root and asks for
local directories. Upload the GitHub Release first, then submit the generated
`server.json` to the official registry. Its URL and SHA-256 must match the uploaded
bundle. Never place authentication material in the repository or archives.
