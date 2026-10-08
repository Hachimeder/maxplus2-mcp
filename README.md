# maxplus2-mcp — MAX+plus II MCP 服务器

[简体中文](README.md) | [English](README.en.md)

让支持 MCP 的 AI agent 使用 MAX+plus II：读取和修改工程、GDF 原理图、SYM
符号和 SCF 波形，运行原厂编译与仿真，并操作 Windows 原生界面。

适用于 Altera MAX+PLUS II / MaxPlus II / MaxPlus2 的数字电路实验与 FPGA/CPLD
工程，包含 AHDL、VHDL、Verilog 源码和专有原理图、波形文件处理。

当前版本 **0.10.3**，提供 **68 个工具**，采用本地 **stdio MCP**。
运行时只使用 Node.js 内置模块，不需要安装 npm 依赖。
Windows 界面后端属于本项目，通过 Win32 和 UI Automation 工作；任何能连接
本地 stdio MCP 的客户端都可调用，无需 Codex Computer Use 或其他 agent SDK。

项目把工程文件解析、原厂命令行与 Windows 界面操作组合在一个服务中。
AI 可以先读取实际电路和波形，以文件方式进行受检修改，再通过原厂工具验证
结果；遇到向导或未解码的编辑器属性时，使用项目自带的界面后端继续操作。

**下载：** [最新 Release](https://github.com/Hachimeder/maxplus2-mcp/releases/latest)
提供精简发行包、完整源码包、标准 MCPB 安装包、目录元数据和 SHA-256 校验文件。

**查找与连接：** [官方 MCP 目录](https://registry.modelcontextprotocol.io/?q=maxplus2) ·
[GitHub 搜索](https://github.com/search?q=maxplus2-mcp&type=repositories) ·
[其他 agent 的查找与连接说明](docs/DISCOVERY.md)。
目录中的名称为 `io.github.Hachimeder/maxplus2-mcp`；连接方式为本地 stdio。

## 能力

| 范围 | 功能 |
| --- | --- |
| 工程和源码 | 新建、复制、查找、读取、编辑、备份和恢复；ACF 配置、HDL、MIF、VEC |
| GDF 原理图 | 原始几何、符号位置、旋转/镜像、引脚坐标、导线、注释、参数和声明 |
| GDF 连接 | 原实例/引脚网络、显式总线逐位连接、受检标量移动补线、匿名叶端清理 |
| SYM 符号 | 新建、编辑、检查、选择性刷新嵌入定义，保留未选实例 |
| 文字和颜色 | 字体、显式 Windows-936 中文、保存的颜色角色；检查并清理覆盖引脚标签的重复 DOC |
| SCF 波形 | 输入事件、X/Z、信号增删、名称、组、进制、顺序和时长；clock/counter/repeat 等刺激 |
| 编译与分析 | 原厂编译、仿真、时序分析、导出综合网表；异步任务、取消、报告与结果验证 |
| Windows 界面 | 窗口、截图、UIA、菜单、键盘、鼠标、拖动和滚动；观察有效期和输入去重 |

工具的参数由 MCP `tools/list` 提供，也可查阅 [完整工具列表](docs/TOOLS.md)。
优先使用文件工具处理已解码格式，界面工具处理向导、菜单和其他编辑器操作。

## 安装与连接

文件工具需要 **Node.js 18+**。原厂编译、仿真和界面操作需要 **Windows** 以及
你自行安装并取得适用许可的 **MAX+plus II**。原厂工具链曾在 10.2 上验证。
界面操作还需要 .NET Framework 4.8 和已登录、未锁定的交互式桌面。
本仓库不包含 MAX+plus II 安装包、程序、设备库或许可证。

### 使用 Release 发行包

支持 MCPB 的 Windows 客户端可导入 `maxplus2-mcp-v0.10.3.mcpb`，在客户端中
选择软件安装目录和工程目录。其他 stdio MCP 客户端使用下面的 ZIP 配置步骤。

1. 从 [v0.10.3 Release](https://github.com/Hachimeder/maxplus2-mcp/releases/tag/v0.10.3)
   下载 `maxplus2-mcp-v0.10.3.zip` 并解压到固定目录。
2. 确认本机已安装 Node.js；执行 `node --version` 检查。
3. 按下面的配置示例连接 MCP 客户端，填写实际软件安装目录和工程目录。

发行包包含运行源码、Windows 后端源码、两种语言的介绍及操作文档。
运行时不需要 Git，不需要执行 npm install；Windows 后端首次使用时自动编译。
`maxplus2-mcp-v0.10.3-source.zip` 另包含开发脚本、公开测试和 CI 模板，适合开发与贡献。

### 从源码安装

```powershell
git clone https://github.com/Hachimeder/maxplus2-mcp.git
cd maxplus2-mcp
node --version
```

复制 [mcp-config.example.json](mcp-config.example.json) 中的服务定义到客户端的
MCP 配置，填写实际路径。示例中的目录是占位路径：

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

若客户端不能从 PATH 找到 Node，将 `command` 改为本机 Node 可执行文件的绝对路径。
客户端的配置格式可能不同，核心是用上述 command、args、env 启动 stdio 进程。

可用以下命令检查路径和原厂编译器，并生成被 Git 忽略的本机配置：

```powershell
node scripts/configure-local.mjs --root "C:\maxplus2" --workspace "C:\fpga-projects"
node scripts/configure-local.mjs --root "C:\maxplus2" --workspace "C:\fpga-projects" --apply
```

也可通过 `start-local.ps1` 启动，或使用以下命令检查安装。正常 stdio 启动后由
MCP 客户端发送 JSON-RPC 请求；诊断日志使用 stderr。

```powershell
node scripts/local-startup.mjs --check --root "C:\maxplus2" --workspace "C:\fpga-projects"
```

原生后端会从 `native/MaxplusDesktop.cs` 自动编译到被忽略的 `bin/`。
手动构建可运行 `pwsh -NoProfile -File scripts/build-desktop.ps1 -SelfTest`。

## 推荐操作顺序

1. `installation_status` 检查环境，`project_clone` 建立工作副本。
2. `project_parse_file` 或专用 inspect 工具读取实际内容和 SHA-256。
3. 用编辑工具预览修改，检查变化、连接和限制；已授权修改使用 `confirm:true`
   及刚读取的 `expectedSha256` 提交。该参数是工具的事务控制。
4. 编译和仿真，检查本次生成的报告、连接和真实输出。异步任务使用
   `job_status` / `job_cancel`。
5. 需要界面时使用 `desktop_windows` → `desktop_observe` → `desktop_action`。
   使用最新的 observationId，读取动作后返回的新观察再决定下一步。

详见 [文件工作流](docs/FILE-FIRST.md)、[界面操作](docs/DESKTOP.md) 和
[格式及限制](docs/FORMATS.md)。

## 验证与开发

以下开发命令在 Git 克隆目录或完整源码包中运行：

```powershell
npm run audit:public
npm test
```

默认测试使用独立样例和模拟后端，不需要 MAX+plus II 安装、私人实验工程或
原厂库文件。需要实机软件验证时设置安装目录：

```powershell
$env:MAXPLUS2_ROOT = "C:\maxplus2"
npm run test:native
```

原厂测试在临时目录建立自制电路，运行编译、仿真和网表检查。原生桌面测试还
需要交互式 Windows 会话。公开检查不依赖原厂安装。
仓库附有 [GitHub Actions 模板](ci/github-actions.yml)；启用方式见 [CI 说明](ci/README.md)。

公开测试中的分页 GDF 在运行时由自制符号生成；SCF 样例来自自制 XOR 工程，
不包含私人课程实验或本机路径。贡献时请运行检查，并使用可公开的最小复现。
测试范围及实测结果见 [验证说明](docs/VERIFICATION.md)。

## 已知边界

文件编辑主要支持已确认的 **GDF v6 / SCF v4**，未知记录保留或拒绝修改。
参数化宏的总线宽度、完整层级内部连接、总线自动布线，以及部分 SCF 编辑器
私有显示字段仍有限制。源连接模型和综合后的网表回答不同问题，修改逻辑后
仍需原厂编译仿真确认。通用界面入口提供软件操作途径，不能证明每个菜单功能
都已经逐项验证；客户端还需把截图传给具备视觉能力的模型处理复杂画布。
实际烧录需要支持的硬件，仓库测试不验证硬件烧录。

## 许可和隐私

本项目代码采用 [MIT License](LICENSE)。第三方软件及样例来源见
[NOTICE.md](NOTICE.md)。本机配置、日志、截图、备份、实验工程及原厂软件不属于
发布内容。MCP 返回的数据可能经客户端发送给模型服务，详见 [SECURITY.md](SECURITY.md)。
