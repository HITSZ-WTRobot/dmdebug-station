import React from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { App } from './App';
import { GamepadDiagnostics } from './components/GamepadDiagnostics';
import './index.css';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

async function boot() {
  try {
    // 只读诊断程序只挂诊断页面，绝不创建工作台的通信引擎或遥控组件。
    const native = '__TAURI_INTERNALS__' in window;
    const mode = native ? await invoke<string>('application_mode') : 'workbench';
    if (mode !== 'workbench' && mode !== 'input-diagnostics') throw new Error('应用启动模式不匹配');
    root.render(<React.StrictMode>{mode === 'input-diagnostics' ? <GamepadDiagnostics /> : <App />}</React.StrictMode>);
  } catch (error) {
    // 诊断引导失败不能回退到含控制功能的工作台。
    root.render(<main className="ozone-page"><h1>程序启动失败</h1><p role="alert">{String(error)}</p><p>未启动串口或电机控制，请关闭后重新打开。</p></main>);
  }
}

void boot();
