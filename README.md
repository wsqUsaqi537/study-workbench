# 学习工作台

一个支持 macOS 和 Windows 的学习计划应用。输入学习目标与周期，按每日计划学习，并通过小测试检验成果。两个平台共用一套源码。学习内容梳理和测试方法参考 ExamPass Skill。

## 下载与安装

前往 [下载页面](https://github.com/wsqUsaqi537/study-workbench/releases/latest)，选择适合你电脑的安装包：

- **Mac（M 系列芯片）**：[下载 ZIP](https://github.com/wsqUsaqi537/study-workbench/releases/download/v0.3.1/study-workbench-0.3.1-mac-arm64.zip)，解压后将“学习工作台”拖入“应用程序”。
- **Windows（x64）**：[下载 EXE](https://github.com/wsqUsaqi537/study-workbench/releases/download/v0.3.1/study-workbench-0.3.1-windows-x64.exe)，双击并按安装向导完成安装。

当前版本为 0.3.1。安装包暂未签名或公证；Windows 版尚未实机验证。

## 使用

首次打开后，请先配置模型 API；学习功能需要 API 才能使用。

1. 点击“新建计划”，填写学习主题、目标、学习周期和每天投入时间，并选择备考、平衡或深度学习。
2. 可选择或拖入 PDF、DOCX、PPTX 文字材料；没有材料也能创建计划。
3. 目标不清楚时，先通过“讨论学习目标”确认学习范围。
4. 生成计划后，查看每日安排，完成学习后勾选进度；遇到难点可打开“学习讲解”，选择简要或展开讲解。
5. 每天完成 5 题小测后查看学习报告；需要补学时，可选择调整后续计划或额外投入时间。周期末完成 10 题测验，查看整个周期的学习报告；错题可点击“问这道题”继续提问。
6. 点击右上角头像进入“我的”，设置头像和昵称。

学习任务和个人设置保存在本机；需要备份时可导出任务。生成学习内容时，相关信息会发送给你配置的模型服务；附件文字需确认后发送。图片和扫描件暂不识别，旧版 DOC、PPT 请先转换。

## 致谢

学习方法适配自 [ExamPass Assistant](https://github.com/WUBING2023/ExamPass-Assistant)，© 2025 ExamPass Assistant Contributors，适配内容有修改。相关内容采用 [CC BY-NC 4.0](./exampass-LICENSE.txt)，仅限非商业使用。
