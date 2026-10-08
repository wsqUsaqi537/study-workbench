const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studyApp', Object.freeze({
  loadState: () => ipcRenderer.invoke('state:load'),
  saveProfile: (profile) => ipcRenderer.invoke('profile:save', profile),
  saveTask: (task) => ipcRenderer.invoke('task:save', task),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  importMaterials: () => ipcRenderer.invoke('materials:import'),
  clarifyGoal: (payload) => ipcRenderer.invoke('learning:clarify', payload),
  generatePlan: (input) => ipcRenderer.invoke('plan:generate', input),
  generateQuiz: (task) => ipcRenderer.invoke('quiz:generate', task),
  gradeQuiz: (payload) => ipcRenderer.invoke('quiz:grade', payload),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  testConnection: () => ipcRenderer.invoke('settings:test')
}));
