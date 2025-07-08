import CDP from 'chrome-remote-interface';
import * as http from 'http';
import { ElectronProcess, CDPTarget } from '../types/index.js';
import { logger } from '../core/logger.js';

/**
 * Helper para requisições HTTP GET.
 * @param url A URL para a qual fazer a requisição.
 * @returns Uma promessa que resolve com o corpo da resposta.
 */
function httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            let data = '';
            response.on('data', (chunk) => data += chunk);
            response.on('end', () => {
                if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
                    resolve(data);
                } else {
                    reject(new Error(`HTTP Error: ${response.statusCode} ${response.statusMessage}`));
                }
            });
        });
        request.on('error', (error) => reject(error));
        request.setTimeout(3000, () => {
            request.destroy();
            reject(new Error('Request timed out'));
        });
    });
}

/**
 * Atualiza a lista de alvos CDP para um processo Electron.
 * @param electronProcess O processo Electron a ser atualizado.
 * @returns Uma promessa que resolve com a lista de alvos CDP.
 */
export async function updateCDPTargets(electronProcess: ElectronProcess): Promise<CDPTarget[]> {
  if (!electronProcess.debugPort) {
    throw new Error('No debug port available for this Electron process');
  }
  
  try {
    const data = await httpGet(`http://localhost:${electronProcess.debugPort}/json/list`);
    const targets = JSON.parse(data) as CDPTarget[];
    electronProcess.targets = targets;
    electronProcess.lastTargetUpdate = new Date();
    logger.info(`Updated CDP targets for process ${electronProcess.id}. Found ${targets.length} targets.`);
    return targets;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error getting CDP targets for process ${electronProcess.id}: ${errorMessage}`);
    throw error;
  }
}

/**
 * Conecta-se a um alvo CDP específico.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo ao qual se conectar.
 * @returns Uma promessa que resolve com o cliente CDP.
 */
export async function connectToCDPTarget(electronProcess: ElectronProcess, targetId: string): Promise<any> {
  if (!electronProcess.debugPort) {
    throw new Error('No debug port available for this Electron process');
  }
  
  try {
    // Garante que temos a lista de alvos mais recente
    if (!electronProcess.targets || !electronProcess.lastTargetUpdate || 
        (new Date().getTime() - electronProcess.lastTargetUpdate.getTime() > 5000)) {
      await updateCDPTargets(electronProcess);
    }
    
    const target = electronProcess.targets?.find(t => t.id === targetId);
    if (!target) {
      throw new Error(`Target ${targetId} not found`);
    }
    
    // Conecta ao alvo usando CDP
    const client = await CDP({
      target: target.webSocketDebuggerUrl || targetId, // Prefere a URL do WebSocket se disponível
      port: electronProcess.debugPort,
      local: true,
    });
    
    // Armazena o cliente para uso posterior
    electronProcess.cdpClient = client;
    logger.info(`Successfully connected to CDP target ${targetId} for process ${electronProcess.id}`);
    return client;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error connecting to CDP target ${targetId}: ${errorMessage}`);
    throw error;
  }
}

/**
 * Inscreve-se em eventos do CDP para logging abrangente.
 * @param client O cliente CDP ativo.
 * @param electronProcess O processo Electron para contextualizar e armazenar os logs.
 */
export function subscribeToCDPEvents(client: any, electronProcess: ElectronProcess): void {
  const logPrefix = `[CDP Event][${electronProcess.id}]`;

  // Garante que o buffer de log exista
  if (!electronProcess.logBuffer) {
    electronProcess.logBuffer = [];
  }

  // Habilitar os domínios necessários
  client.Runtime.enable();
  client.Network.enable();
  client.Console.enable();
  client.Security.enable();


  // Capturar logs do console
  client.Runtime.on('consoleAPICalled', ({ type, args, executionContextId, timestamp }: { type: string, args: any[], executionContextId: number, timestamp: number }) => {
    const message = args.map(arg => arg.value !== undefined ? JSON.stringify(arg.value) : `[${arg.type}]`).join(' ');
    const level = type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'log';
    
    logger.info(`${logPrefix}[Console.${type}] ${message}`);
    electronProcess.logBuffer.push({
      type: 'console',
      level,
      message,
      timestamp: new Date(timestamp),
      source: `context:${executionContextId}`,
      payload: args,
    });
  });

  // Capturar exceções não tratadas
  client.Runtime.on('exceptionThrown', ({ timestamp, exceptionDetails }: { timestamp: number, exceptionDetails: any }) => {
    logger.error(`${logPrefix}[Exception] ${exceptionDetails.text}`, exceptionDetails);
    electronProcess.logBuffer.push({
      type: 'runtime',
      level: 'error',
      message: exceptionDetails.text,
      timestamp: new Date(timestamp),
      source: exceptionDetails.url || 'runtime',
      payload: exceptionDetails,
    });
  });

  // Capturar eventos de rede
  client.Network.on('requestWillBeSent', ({ requestId, request, timestamp }: { requestId: string, request: any, timestamp: number }) => {
    const message = `${request.method} ${request.url}`;
    logger.info(`${logPrefix}[Network Request] ${message}`);
    electronProcess.logBuffer.push({
        type: 'network',
        level: 'info',
        message,
        timestamp: new Date(timestamp * 1000), // timestamp é em segundos
        source: 'network.request',
        payload: { requestId, request },
    });
  });

  client.Network.on('responseReceived', ({ requestId, response, timestamp }: { requestId: string, response: any, timestamp: number }) => {
    const message = `${response.status} ${response.url}`;
    logger.info(`${logPrefix}[Network Response] ${message}`);
    const level = response.status >= 400 ? 'error' : response.status >= 300 ? 'warn' : 'info';
    electronProcess.logBuffer.push({
        type: 'network',
        level,
        message,
        timestamp: new Date(timestamp * 1000),
        source: 'network.response',
        payload: { requestId, response },
    });
  });

  // Capturar eventos de segurança
  client.Security.on('securityStateChanged', ({ securityState, summary, explanations }: { securityState: string, summary: string, explanations: any[] }) => {
    const message = `Security state changed: ${securityState}. ${summary}`;
    logger.warn(`${logPrefix}[Security] ${message}`);
    electronProcess.logBuffer.push({
        type: 'security',
        level: securityState === 'secure' ? 'info' : 'warn',
        message,
        timestamp: new Date(),
        source: 'security.state',
        payload: { securityState, summary, explanations },
    });
  });


  logger.info(`${logPrefix} Subscribed to Runtime, Network, Console and Security events.`);
}
 
/**
 * Executa um comando CDP em um alvo.
 * @param electronProcess O processo Electron.
 * @param targetId O ID do alvo.
 * @param domain O domínio do comando (ex: 'Page', 'Runtime').
 * @param command O comando a ser executado.
 * @param params Os parâmetros para o comando.
 * @returns Uma promessa que resolve com o resultado do comando.
 */
export async function executeCDPCommand(electronProcess: ElectronProcess, targetId: string, domain: string, command: string, params: any = {}): Promise<any> {
  let client = electronProcess.cdpClient;
  
  try {
    // Obtém ou cria um cliente CDP se não existir um para o alvo correto
    if (!client) {
      logger.warn(`No existing CDP client for process ${electronProcess.id}, creating a new one for target ${targetId}.`);
      client = await connectToCDPTarget(electronProcess, targetId);
    }
    
    // Executa o comando
    const result = await client.send(`${domain}.${command}`, params);
    
    // Garante que os eventos estão sendo ouvidos
    if (client.listenerCount('Runtime.consoleAPICalled') === 0) {
      subscribeToCDPEvents(client, electronProcess);
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error executing CDP command ${domain}.${command}: ${errorMessage}`);
    // Em caso de erro, pode ser útil fechar o cliente para forçar uma reconexão na próxima vez
    if (client) {
        await client.close();
        electronProcess.cdpClient = undefined;
    }
    throw error;
  }
}
