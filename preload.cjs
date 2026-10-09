const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('studyApp', Object.freeze({
  loadState: () => ipcRenderer.invoke('state:load'),
  saveProfile: (profile) => ipcRenderer.invoke('profile:save', profile),
  saveTask: (task) => ipcRenderer.invoke('task:save', task),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  importMaterials: () => ipcRenderer.invoke('materials:import'),
  importDroppedMaterials: (files) => {
    if (!Array.isArray(files) || files.length < 1 || files.length > 10) return Promise.reject(new Error('每次请拖入 1 至 10 份材料。'));
    const paths = files.map(file => webUtils.getPathForFile(file));
    if (paths.some(filePath => !filePath)) return Promise.reject(new Error('请从电脑中拖入实际的 PDF、DOCX 或 PPTX 文件。'));
    return ipcRenderer.invoke('materials:drop', paths);
  },
  clarifyGoal: (payload) => ipcRenderer.invoke('learning:clarify', payload),
  generatePlan: (input) => ipcRenderer.invoke('plan:generate', input),
  generateLesson: (payload) => ipcRenderer.invoke('tutoring:lesson', payload),
  answerQuestion: (payload) => ipcRenderer.invoke('tutoring:question', payload),
  generateAssessment: (task, selector) => ipcRenderer.invoke('assessment:generate', { task, selector }),
  gradeAssessment: (payload) => ipcRenderer.invoke('assessment:grade', payload),
  proposeAdjustment: (payload) => ipcRenderer.invoke('plan:adjust', payload),
  generateQuiz: (task) => ipcRenderer.invoke('quiz:generate', task),
  gradeQuiz: (payload) => ipcRenderer.invoke('quiz:grade', payload),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testConnection: () => ipcRenderer.invoke('settings:test')
}));
