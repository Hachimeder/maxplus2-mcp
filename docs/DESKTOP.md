# 独立 Windows 界面后端

后端源码为 `native/MaxplusDesktop.cs`，通过 Win32 输入、窗口/菜单查询、截图和
UI Automation 控件读取提供操作。需要 Windows、.NET Framework 4.8 和可交互
桌面；运行时自动构建，服务关闭时清理自己启动的后端。

1. `desktop_status` 检查后端与桌面。`desktop_launch` 启动安装目录内允许的
   软件程序；`desktop_windows` 返回真实 windowId、进程、标题和边界。
2. 对选中的 windowId 调用 `desktop_observe`，读取图片、accessibility.tree、
   菜单和焦点，取得有效期有限的 observationId。
3. `desktop_action` 使用这个 windowId 和 observationId 执行一步，检查返回
   的新观察后继续。窗口移动、调整大小或关闭后重新观察。

支持 click、move、drag、scroll、press_key、type_text、set_value、invoke_menu、
activate_window 等动作。参数及支持的控件动作以工具 schema 和实际观察为准。
控件/菜单索引来自当前返回值；菜单只调用当前启用的叶命令。
鼠标坐标使用选中窗口左上角为原点的物理像素，提供对应 screenshotId；
弹窗截图按它返回的 originX/originY 定位。可按 textOffset/textLimit 和
menuOffset/menuLimit 分页，使用返回的续页字段。

图像以标准 MCP image 内容返回。客户端需将其转给有视觉能力的模型；纯文字
客户端仍可使用文件工具和控件树，但复杂画布交互能力取决于模型和客户端。

`inputDelivered:true` 仅证明输入发送，仍须观察 UI 和检查文件。唯一
operationId 可避免同一参数重复输入；相同 ID 及相同参数重试获取缓存。
`desktop_result` 可找回最近结果。动作失败可能意味着结果未知，先按 recovery
重新列窗口/观察，禁止盲目重复 click、type_text 或快捷键。

对话框被覆盖、焦点不正确、锁屏、桌面不可交互或观察过期时停止输入并返回
诊断。通用输入入口能操作编辑器、向导及其他菜单，不表示所有软件功能都已
逐项验证。实际烧录、擦除、硬件校验需另外具备支持的硬件和许可。
