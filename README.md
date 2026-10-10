# Study Workbench

A desktop learning planner for macOS and Windows. Turn your learning goals and materials into daily tasks, explanations, quizzes and learning reports. Both platforms share the same codebase. Learning and assessment methods draw on the ExamPass Skill.

## Download and install

Get the app from [Releases](https://github.com/wsqUsaqi537/study-workbench/releases/latest):

- **macOS — Apple Silicon:** [Download ZIP](https://github.com/wsqUsaqi537/study-workbench/releases/download/v0.6.0/study-workbench-0.6.0-mac-arm64.zip). Unzip it and move “学习工作台” to Applications.
- **Windows — x64:** [Download EXE](https://github.com/wsqUsaqi537/study-workbench/releases/download/v0.6.0/study-workbench-0.6.0-windows-x64.exe). Run the installer and follow the prompts.

Packages are unsigned, and the Mac app is not notarized. The Windows package has not yet been tested on a Windows PC.

## Use the app

Configure your model API in **API settings** before using learning features.

1. Create a plan with your topic, goal, study duration and daily time budget. Choose Exam preparation, Balanced or Deep study. The duration is a calendar span: study every day, every other day, or on selected weekdays.
2. Optionally select or drop PDF, DOCX, PPTX, MD or TEX materials. You can also make a plan without attachments. Discuss an unclear goal before generating your plan. For exams, optionally add an exam outline as text or a separate attachment; self-study needs no exam outline.
3. Follow your daily tasks and mark your progress. Open a brief or detailed explanation when you need help. Change your study frequency from the plan page and review the proposed future schedule before applying it; past and completed tasks are kept.
4. Take a five-question daily quiz and read your daily report. If you need more preparation, choose extra study time or preview and approve a revised schedule.
5. Finish with a ten-question final test and a report covering the study cycle. Quizzes mainly use multiple-choice and fill-in-the-blank questions; the final test may include up to two short-answer questions. Ask follow-up questions about mistakes when needed.
6. Open the avatar menu to set your nickname, photo and language: Simplified Chinese or English. The first launch follows your system language. Newly generated content uses your selected language; existing content keeps its original text.

Plans and settings stay on your computer. You can export plans for backup. Generating content sends relevant information to your configured model service; sending attachment text requires your consent. Saved explanations and tests can be reopened without another model request.

PDF pages with unreadable extracted text are recognized locally with bundled Chinese and English OCR. Larger documents may take time; check formulas against the original pages. Convert legacy DOC/PPT files first. MD/TEX must be UTF-8 text; TEX is read as source without compilation.

## Credits

Learning methods are adapted from [ExamPass Assistant](https://github.com/WUBING2023/ExamPass-Assistant), © 2025 ExamPass Assistant Contributors, with modifications. The adapted material is licensed under [CC BY-NC 4.0](./exampass-LICENSE.txt), for noncommercial use only.
