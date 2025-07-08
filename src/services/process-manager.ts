import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as net from 'net';
import { ElectronProcess, CDPTarget } from '../types/index.js';
import { logger } from '../core/logger.js';
// A função updateCDPTargets será movida para o cdp-client, mas é necessária aqui por enquanto.
// Para evitar dependência circular, vamos defini-la temporariamente.
// No final da Fase 1, isso será limpo.
import { updateCDPTargets } from './cdp-client.js';

// O estado dos processos será gerenciado aqui.
const electronProcesses: Map<string, ElectronProcess> = new Map();

/**
 * Retorna o estado atual do mapa de processos.
 * @returns O mapa de processos do Electron.
 */
export function getElectronProcesses(): Map<string, ElectronProcess> {
    return electronProcesses;
}

/**
 * Tenta encontrar o executável do Electron em locais comuns.
 * @returns O caminho para o executável do Electron ou 'electron' se estiver no PATH.
 */
export function getElectronExecutablePath(): string {
  const possiblePaths = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'electron.cmd'),
    path.resolve(process.cwd(), 'node_modules', '.bin', 'electron.cmd'),
    // Adicionar caminhos para outros SOs se necessário
  ];

  for (const electronPath of possiblePaths) {
    if (fs.existsSync(electronPath)) {
      logger.info(`Electron executable found at: ${electronPath}`);
      return electronPath;
    }
  }

  logger.info('Electron executable not found in common paths, assuming it is in PATH.');
  return 'electron';
}

/**
 * @deprecated Use manageApp({ action: 'start', ... }) instead.
 * Inicia uma nova aplicação Electron com depuração remota ativada.
 * @param appPath Caminho para a aplicação Electron.
 * @param debugPort Porta para o debugging remoto (opcional).
 * @returns Uma promessa que resolve com o objeto ElectronProcess.
 */
export async function startElectronApp(
  appPath: string,
  options: { debugPort?: number; reconnect?: boolean } = {}
): Promise<ElectronProcess> {
  const { reconnect = false } = options;
  let { debugPort } = options;

  const id = `electron-${Date.now()}`;
  const args = [appPath];
  
  if (!debugPort) {
    debugPort = Math.floor(Math.random() * (9999 - 9222 + 1)) + 9222;
  }
  
  args.unshift(`--remote-debugging-port=${debugPort}`);
  args.unshift('--enable-logging');
  
  const electronPath = getElectronExecutablePath();
  const electronProc = spawn(electronPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
  });
  
  const electronProcess: ElectronProcess = {
    id,
    process: electronProc,
    name: path.basename(appPath),
    status: 'running',
    pid: electronProc.pid,
    debugPort,
    startTime: new Date(),
    logBuffer: [],
    appPath,
    reconnect,
    reconnectAttempts: 0
  };
  
  electronProc.stdout.on('data', (data: Buffer) => {
    const log = data.toString();
    electronProcess.logBuffer.push({ type: 'console', level: 'info', message: log, timestamp: new Date(), source: 'stdout' });
    logger.info(`[Electron ${id}] ${log}`);
  });
  
  electronProc.stderr.on('data', (data: Buffer) => {
    const log = data.toString();
    electronProcess.logBuffer.push({ type: 'console', level: 'error', message: log, timestamp: new Date(), source: 'stderr' });
    logger.error(`[Electron ${id}] ${log}`);
  });
  
  electronProc.on('exit', (code: number | null) => {
    const status = code === 0 ? 'stopped' : 'crashed';
    electronProcess.status = status;
    logger.info(`[Electron ${id}] Process exited with code ${code}, status: ${status}`);

    if (electronProcess.cdpClient) {
      try {
        electronProcess.cdpClient.close();
      } catch (err) {
        logger.error(`[Electron ${id}] Error closing CDP client:`, err);
      }
      electronProcess.cdpClient = undefined;
    }

    // Lógica de reconexão automática
    if (status === 'crashed' && electronProcess.reconnect) {
      const maxReconnects = 5;
      electronProcess.reconnectAttempts = (electronProcess.reconnectAttempts || 0) + 1;

      if (electronProcess.reconnectAttempts <= maxReconnects) {
        logger.info(`[Electron ${id}] Attempting to reconnect (${electronProcess.reconnectAttempts}/${maxReconnects})...`);
        setTimeout(() => {
          reloadElectronApp(id).catch(err => {
            logger.error(`[Electron ${id}] Failed to reconnect:`, err);
          });
        }, 2000 * electronProcess.reconnectAttempts); // Backoff exponencial
      } else {
        logger.error(`[Electron ${id}] Max reconnect attempts reached. Giving up.`);
      }
    }
  });
  
  electronProcesses.set(id, electronProcess);
  
  await new Promise(resolve => setTimeout(resolve, 2000)); // Aumentado para dar mais tempo
  
  try {
    await updateCDPTargets(electronProcess);
  } catch (err) {
    logger.warn(`[Electron ${id}] Could not connect to CDP initially. The app might still be starting.`, err);
  }
  
  return electronProcess;
}

/**
 * @deprecated Use manageApp({ action: 'stop', ... }) instead.
 * Para uma aplicação Electron em execução.
 * @param id O ID do processo a ser parado.
 * @returns True se o processo foi parado com sucesso, false caso contrário.
 */
export function stopElectronApp(id: string): boolean {
  const electronProcess = electronProcesses.get(id);
  if (!electronProcess) {
    logger.warn(`Process with id ${id} not found for stopping.`);
    return false;
  }
  
  if (electronProcess.cdpClient) {
    try {
      electronProcess.cdpClient.close();
    } catch (err) {
      logger.error(`[Electron ${id}] Error closing CDP client:`, err);
    }
    electronProcess.cdpClient = undefined;
  }
  
  if (electronProcess.process) {
      electronProcess.process.kill();
  }
  electronProcess.status = 'stopped';
  // Opcional: remover do mapa após um tempo ou manter como 'stopped'
  // electronProcesses.delete(id);
  logger.info(`Process ${id} stopped.`);
  return true;
}


function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let data = '';
      response.on('data', (chunk) => data += chunk);
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        }
      });
    });
    request.on('error', (error) => reject(error));
    request.setTimeout(2000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

function checkPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * @deprecated Use discoverApps({ scope: 'network' }) instead.
 * Procura por aplicações Electron existentes com portas de depuração ativas.
 * @returns Uma promessa que resolve com uma lista de portas ativas.
 */
export async function scanForElectronApps(): Promise<number[]> {
  const commonPorts = [9222, 9223, 9229]; // Portas comuns
  const activePorts: number[] = [];
  
  for (const port of commonPorts) {
    try {
      const isActive = await checkPortInUse(port);
      if (isActive) {
        try {
          const data = await httpGet(`http://localhost:${port}/json/list`);
          const targets = JSON.parse(data);
          if (Array.isArray(targets)) {
            activePorts.push(port);
            logger.info(`Found Electron debug port: ${port}`);
          }
        } catch (err) {
            // não é um endpoint de debug
        }
      }
    } catch (err) {
        // erro ao checar a porta
    }
  }
  return activePorts;
}

/**
 * @deprecated Use manageApp({ action: 'connect', ... }) instead.
 * Conecta-se a uma aplicação Electron já em execução.
 * @param port A porta de depuração da aplicação existente.
 * @returns Uma promessa que resolve com o objeto ElectronProcess.
 */
export async function connectToExistingElectronApp(port: number): Promise<ElectronProcess> {
  try {
    const data = await httpGet(`http://localhost:${port}/json/list`);
    const targets = JSON.parse(data) as CDPTarget[];
    
    if (!Array.isArray(targets) || targets.length === 0) {
      throw new Error('No debuggable targets found');
    }
    
    const id = `electron-existing-${port}`;
    const electronProcess: ElectronProcess = {
      id,
      process: null, // Sem processo filho, pois é um app existente
      name: `Existing App (Port ${port})`,
      status: 'running',
      debugPort: port,
      startTime: new Date(),
      logBuffer: [{ type: 'console', level: 'info', message: `Connected to existing Electron app on port ${port}`, timestamp: new Date(), source: 'mcp-server' }],
      appPath: 'existing',
      targets
    };
    
    electronProcesses.set(id, electronProcess);
    logger.info(`Connected to existing Electron app on port ${port} with ${targets.length} targets`);
    
    return electronProcess;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to connect to Electron app on port ${port}: ${errorMessage}`);
    throw new Error(`Failed to connect to Electron app on port ${port}: ${errorMessage}`);
  }
}

/**
 * @deprecated Use manageApp({ action: 'stop', ... }) instead.
 * Encerra uma aplicação Electron de forma controlada.
 * Alias para stopElectronApp para clareza semântica.
 * @param id O ID do processo a ser encerrado.
 * @returns True se o processo foi encerrado com sucesso, false caso contrário.
 */
export function terminateElectronApp(id: string): boolean {
  logger.info(`Terminating process ${id}...`);
  return stopElectronApp(id);
}

/**
 * @deprecated Use manageApp({ action: 'reload', ... }) instead.
 * Recarrega (hard reload) uma aplicação Electron.
 * Isso é feito encerrando o processo atual e iniciando um novo com a mesma configuração.
 * @param id O ID do processo a ser recarregado.
 * @returns Uma promessa que resolve com o novo objeto ElectronProcess.
 */
export async function reloadElectronApp(id: string): Promise<ElectronProcess> {
  const electronProcess = electronProcesses.get(id);
  if (!electronProcess) {
    const errorMsg = `Process with id ${id} not found for reloading.`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  const { appPath, debugPort, reconnect } = electronProcess;

  if (appPath === 'existing' || !appPath) {
      const errorMsg = `Cannot reload an existing app connection (Port ${debugPort}). You must restart it manually.`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
  }

  logger.info(`Reloading process ${id} (${appPath})...`);
  
  stopElectronApp(id);
  
  // Aguarda um momento para garantir que a porta foi liberada
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  logger.info(`Restarting process for ${appPath}...`);
  return startElectronApp(appPath, { debugPort, reconnect });
}

/**
 * Gerencia o ciclo de vida de uma aplicação Electron.
 * @param params Parâmetros para gerenciar a aplicação.
 * @returns O resultado da operação.
 */
export async function manageApp(params: {
  action: 'start' | 'connect' | 'stop' | 'reload';
  appPath?: string;
  port?: number;
  appId?: string;
  reconnect?: boolean;
}): Promise<ElectronProcess | boolean> {
  const { action, appPath, port, appId, reconnect } = params;

  switch (action) {
    case 'start':
      if (!appPath) throw new Error('appPath is required for start action.');
      return startElectronApp(appPath, { debugPort: port, reconnect });
    case 'connect':
      if (!port) throw new Error('port is required for connect action.');
      return connectToExistingElectronApp(port);
    case 'stop':
      if (!appId) throw new Error('appId is required for stop action.');
      return stopElectronApp(appId);
    case 'reload':
      if (!appId) throw new Error('appId is required for reload action.');
      return reloadElectronApp(appId);
    default:
      throw new Error(`Invalid action: ${action}`);
  }
}

/**
 * Descobre aplicações Electron em execução.
 * @param params Parâmetros para a descoberta.
 * @returns Uma lista de aplicações encontradas.
 */
export async function discoverApps(
  params: { scope?: 'managed' | 'network' | 'all' } = {}
): Promise<{ managed: ElectronProcess[]; network: number[] }> {
  const { scope = 'all' } = params;
  const result: { managed: ElectronProcess[]; network: number[] } = {
    managed: [],
    network: [],
  };

  if (scope === 'managed' || scope === 'all') {
    result.managed = Array.from(electronProcesses.values());
  }

  if (scope === 'network' || scope === 'all') {
    result.network = await scanForElectronApps();
  }

  return result;
}