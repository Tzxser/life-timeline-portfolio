# Life Timeline 本地日记与时间轴应用

面向 Windows 与 Android 的本地日记应用，使用 Next.js、React、TypeScript、Tauri 2、Rust 与 SQLite。此仓库提供招聘展示所需的应用核心、数据层和测试源码。

## 主要功能

- 时间轴、人生阶段、富文本编辑、附件与图集。
- 本地持久化、备份恢复、日记包导入导出与冲突处理。
- 可预览、可撤回的 AI 辅助导入，以及手机日程导入和编辑。
- Windows 与 Android 的文件交互、后台保存及更新策略。

## 建议阅读

- 界面与交互：`components/`、`lib/life-store.tsx`。
- 持久化与事务：`src-tauri/src/repository.rs`、`src-tauri/src/migrations.rs`。
- AI 导入：`src-tauri/src/ai_import.rs`、`src-tauri/src/ai_api.rs`。
- 备份与传输：`src-tauri/src/backup_tests.rs`、`src-tauri/src/phone_transfer.rs`。
- 前端回归：`tests/`；Rust 回归包含在对应源码模块中。

## 验证与范围

原项目 0.2.14 的验收记录列出 124 项前端测试、158 项 Windows Rust 测试，以及 Android 模拟器保存和恢复检查。实体 ARM64 手机、物理中文输入法和干净 Windows 首装仍有未验证范围。这些是历史项目记录，本展示副本发布时未重新运行整套测试。

该副本保留核心源码与依赖声明，未包含生产发布脚本、签名密钥、安装包、用户资料库、日记、个人附件或历史交接压缩包。Android 工程生成文件需要通过 Tauri 工具链重新生成。示例日记文件已明确标记为虚构通用内容。

## 本地阅读与开发

安装与 `package.json` 相符的 Node.js/pnpm 后，可执行 `pnpm install --frozen-lockfile` 和 `pnpm dev` 查看前端开发界面。原生能力还需配置 Rust、Tauri 及对应平台工具链；本仓库不承诺开箱即用的签名安装包。
