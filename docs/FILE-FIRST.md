# 文件优先工作流

`project_parse_file` 统一读取 GDF、SCF、ACF、TBL、报告和 EDIF，返回字节数、
SHA-256 和结构化结果。路径属于明确的 workspace 或 project 作用域。
分页时使用结果提供的 nextOffset；父集合的 offset/limit 与子集合的
childOffset/childLimit 分开使用，避免遗漏第二页的引脚和名称。

GDF 原始布局使用 `gdf_geometry`；电路源连接使用 `gdf_connections`，显式数字
总线提供逐位拓扑。`gdf_create` / `gdf_construct` 新建原理图、插入符号、导线、
端口名和注释。`gdf_edit` 修改已解码几何；`gdf_move_connected` 在支持的标量
拓扑上移动元件并受检补线。`gdf_wire_cleanup` 只剪除可安全证明的匿名叶端。
字体使用 `gdf_text_format_inspect` / `gdf_text_format_edit`，中文需显式指定
Windows-936 编码及可靠的字体度量。

`sym_inspect` / `sym_create` / `sym_edit` 操作独立符号；自定义层级符号还需配套
逻辑源文件。`gdf_symbol_refresh` 更新选中的嵌入定义，检查接口和接触变化，
不会自动重接导线。`gdf_declarations` / `gdf_declarations_edit` 处理支持的
CONSTANT/PARAM 属性对，现代实例参数由 `gdf_construct` 处理。

`gdf_pin_labels` 检查重复 DOC 与原生引脚标签。先 inspect，再带当前哈希预览；
应用时备份原文件，仅移除满足严格条件的重复文字，不删除引脚或改电气名称。
文字对齐仅适用于已确认的内置字体和充足的空间；未知字体度量不会猜测。

SCF 使用 `scf_inspect`、`scf_structure` 和 `scf_editor_metadata` 读取波形及
结构。`scf_create` 新建输入波形，`scf_edit` 修改事件，`scf_structure_edit`
修改名称、组、进制、顺序、时长和输入。时间以 ns 表示，事件精度为 0.1 ns，
保留 X/Z。`scf_stimulus_edit` 生成或变换 clock、repeat、counter、shift、invert、
fill_range 和 copy_range。修改输入后原输出轨迹过期，需要重新仿真。

编译端口由原厂 `netlist_export` 得到 EDIF，再使用 `scf_compiled_ports`、
`scf_ports_import` 或 `scf_from_compiled_create`。EDIF、SCF 的哈希分别核对。
网表导出在工程副本运行并检查源文件完整性；综合会改变实例和逻辑结构，不能
把综合实例当作原图的布局对象。

修改默认预览，提供 `confirm:true` 执行已授权动作。已有文件要求当前
`expectedSha256`；修改结果提供前后哈希和备份。恢复时调用
`project_restore_file`，使用原始哈希作为 backupSha256，目标当前哈希作为
expectedSha256。大工程先复制 sources，并显式包含需要保留的刺激文件。

`maxplus2_run` 支持编译、仿真、时序分析和异步任务。默认失效相关 CNF 缓存，
防止快速等长修改复用旧逻辑。`simulate_and_verify`、`parse_tbl`、
`waveform_signals` / `waveform_results` 检查实际结果；未知值、旧报告、单独的
退出码或截图都不能证明本次电路行为正确。
