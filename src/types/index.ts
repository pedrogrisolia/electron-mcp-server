import { ChildProcess } from 'child_process';

// Tipos movidos do index.ts original para melhor organização.

export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

export interface ElectronProcess {
  id: string;
  process: ChildProcess | null; // Pode ser nulo para processos existentes
  name: string;
  status: 'running' | 'stopped' | 'crashed';
  pid?: number;
  debugPort?: number;
  startTime: Date;
  appPath: string;
  cdpClient?: any; // Cliente do Chrome DevTools Protocol
  targets?: CDPTarget[]; // Alvos de depuração disponíveis
  lastTargetUpdate?: Date; // Quando os alvos foram atualizados pela última vez
  screenshots?: string[]; // Caminhos de screenshots armazenados
  reconnect?: boolean; // Se deve tentar reconectar automaticamente
  reconnectAttempts?: number; // Número de tentativas de reconexão
  logBuffer: LogEntry[];
}

export interface LogEntry {
  type: 'console' | 'network' | 'runtime' | 'security';
  level: 'log' | 'warn' | 'error' | 'info' | 'debug' | 'verbose';
  message: string;
  timestamp: Date;
  source: string;
  payload?: any;
}

export interface ElectronDebugInfo {
  webContents: ElectronWebContentsInfo[];
  processes: {
    main: ProcessInfo;
    renderers: ProcessInfo[];
  };
}

export interface ElectronWebContentsInfo {
  id: number;
  url: string;
  title: string;
  debuggable: boolean;
  debugPort?: number;
  targetId?: string; // ID do alvo CDP
}

export interface ProcessInfo {
  pid: number;
  cpuUsage: number;
  memoryUsage: number;

  status: string;
}

export interface TestResult {
  success: boolean;
  action: string;
  details: any;
  screenshot?: string;
  logs?: string[];
  domState?: any;
  timing: {
    startTime: number;
    endTime: number;
    duration: number;
  };
}
