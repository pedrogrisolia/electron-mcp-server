import CDP from 'chrome-remote-interface';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ElectronProcess, CDPTarget } from '../types/index.js';
import { logger } from '../core/logger.js';

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

function parseDevToolsActivePort(contents: string): number | null {
  const firstLine = contents.split(/\r?\n/)[0]?.trim();
  if (!firstLine) return null;
  const port = Number.parseInt(firstLine, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return port;
}

/** Reads DevToolsActivePort files from common Electron userData locations. */
export async function discoverPortsFromDevToolsActivePort(): Promise<
  Array<{ port: number; profile: string }>
> {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  if (!fs.existsSync(roaming)) return [];

  const found: Array<{ port: number; profile: string }> = [];
  for (const entry of fs.readdirSync(roaming, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(roaming, entry.name, 'DevToolsActivePort');
    if (!fs.existsSync(filePath)) continue;
    try {
      const port = parseDevToolsActivePort(fs.readFileSync(filePath, 'utf8'));
      if (port) found.push({ port, profile: entry.name });
    } catch {
      // ignore unreadable profiles
    }
  }
  return found;
}

async function isDebugPortActive(port: number): Promise<boolean> {
  try {
    await httpGet(`http://127.0.0.1:${port}/json/version`);
    return true;
  } catch {
    return false;
  }
}

function mapTargetInfo(info: any): CDPTarget {
  return {
    id: info.targetId || info.id,
    type: info.type || 'page',
    title: info.title || '',
    url: info.url || '',
    webSocketDebuggerUrl: info.webSocketDebuggerUrl,
    devtoolsFrontendUrl: info.devtoolsFrontendUrl,
  };
}

/** Fetches CDP targets from /json/list, CDP.List, or Target.getTargets. */
export async function fetchCDPTargets(port: number): Promise<CDPTarget[]> {
  try {
    const listData = await httpGet(`http://127.0.0.1:${port}/json/list`);
    const listed = JSON.parse(listData);
    if (Array.isArray(listed) && listed.length > 0) {
      return listed as CDPTarget[];
    }
  } catch {
    // fall through
  }

  try {
    const criList = await CDP.List({ port, local: true });
    if (Array.isArray(criList) && criList.length > 0) {
      return criList.map(mapTargetInfo);
    }
  } catch {
    // fall through
  }

  try {
    const version = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/version`));
    if (!version?.webSocketDebuggerUrl) return [];

    const browser = await CDP({ target: version.webSocketDebuggerUrl, local: true });
    try {
      await browser.send('Target.setDiscoverTargets', { discover: true });
      const { targetInfos } = await browser.send('Target.getTargets', {});
      return (targetInfos || []).map(mapTargetInfo);
    } finally {
      await browser.close();
    }
  } catch (error) {
    logger.debug(`fetchCDPTargets fallback failed for port ${port}: ${error}`);
    return [];
  }
}

export async function waitForPageTargets(
  port: number,
  timeoutMs = 15000,
  intervalMs = 500
): Promise<CDPTarget[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetchCDPTargets(port);
    const pages = targets.filter((t) => t.type === 'page');
    if (pages.length > 0) return targets;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return fetchCDPTargets(port);
}

export async function updateCDPTargets(electronProcess: ElectronProcess): Promise<CDPTarget[]> {
  if (!electronProcess.debugPort) {
    throw new Error('No debug port available for this Electron process');
  }

  const targets = await fetchCDPTargets(electronProcess.debugPort);
  electronProcess.targets = targets;
  electronProcess.lastTargetUpdate = new Date();
  logger.info(
    `Updated CDP targets for process ${electronProcess.id}. Found ${targets.length} targets.`
  );
  return targets;
}

export async function connectToCDPTarget(
  electronProcess: ElectronProcess,
  targetId: string
): Promise<any> {
  if (!electronProcess.debugPort) {
    throw new Error('No debug port available for this Electron process');
  }

  if (
    !electronProcess.targets ||
    !electronProcess.lastTargetUpdate ||
    Date.now() - electronProcess.lastTargetUpdate.getTime() > 5000
  ) {
    await updateCDPTargets(electronProcess);
  }

  const target = electronProcess.targets?.find((t) => t.id === targetId);
  if (!target) {
    throw new Error(`Target ${targetId} not found`);
  }

  if (electronProcess.cdpClient && electronProcess.cdpTargetId !== targetId) {
    try {
      await electronProcess.cdpClient.close();
    } catch {
      // ignore close errors
    }
    electronProcess.cdpClient = undefined;
  }

  if (!electronProcess.cdpClient) {
    const client = await CDP({
      target: target.webSocketDebuggerUrl || targetId,
      port: electronProcess.debugPort,
      local: true,
    });
    electronProcess.cdpClient = client;
    electronProcess.cdpTargetId = targetId;
    logger.info(
      `Successfully connected to CDP target ${targetId} for process ${electronProcess.id}`
    );
  }

  return electronProcess.cdpClient;
}

export function subscribeToCDPEvents(client: any, electronProcess: ElectronProcess): void {
  const logPrefix = `[CDP Event][${electronProcess.id}]`;

  if (!electronProcess.logBuffer) {
    electronProcess.logBuffer = [];
  }

  client.Runtime.enable();
  client.Network.enable();
  client.Console.enable();
  client.Security.enable();

  client.Runtime.on(
    'consoleAPICalled',
    ({
      type,
      args,
      executionContextId,
      timestamp,
    }: {
      type: string;
      args: any[];
      executionContextId: number;
      timestamp: number;
    }) => {
      const message = args
        .map((arg) => (arg.value !== undefined ? JSON.stringify(arg.value) : `[${arg.type}]`))
        .join(' ');
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
    }
  );

  client.Runtime.on(
    'exceptionThrown',
    ({ timestamp, exceptionDetails }: { timestamp: number; exceptionDetails: any }) => {
      logger.error(`${logPrefix}[Exception] ${exceptionDetails.text}`, exceptionDetails);
      electronProcess.logBuffer.push({
        type: 'runtime',
        level: 'error',
        message: exceptionDetails.text,
        timestamp: new Date(timestamp),
        source: exceptionDetails.url || 'runtime',
        payload: exceptionDetails,
      });
    }
  );

  client.Network.on(
    'requestWillBeSent',
    ({ requestId, request, timestamp }: { requestId: string; request: any; timestamp: number }) => {
      const message = `${request.method} ${request.url}`;
      logger.info(`${logPrefix}[Network Request] ${message}`);
      electronProcess.logBuffer.push({
        type: 'network',
        level: 'info',
        message,
        timestamp: new Date(timestamp * 1000),
        source: 'network.request',
        payload: { requestId, request },
      });
    }
  );

  client.Network.on(
    'responseReceived',
    ({ requestId, response, timestamp }: { requestId: string; response: any; timestamp: number }) => {
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
    }
  );

  client.Security.on(
    'securityStateChanged',
    ({
      securityState,
      summary,
      explanations,
    }: {
      securityState: string;
      summary: string;
      explanations: any[];
    }) => {
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
    }
  );

  logger.info(`${logPrefix} Subscribed to Runtime, Network, Console and Security events.`);
}

export async function executeCDPCommand(
  electronProcess: ElectronProcess,
  targetId: string,
  domain: string,
  command: string,
  params: any = {}
): Promise<any> {
  let client = electronProcess.cdpClient;

  try {
    if (!client || electronProcess.cdpTargetId !== targetId) {
      client = await connectToCDPTarget(electronProcess, targetId);
    }

    const result = await client.send(`${domain}.${command}`, params);

    if (client.listenerCount('Runtime.consoleAPICalled') === 0) {
      subscribeToCDPEvents(client, electronProcess);
    }

    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error executing CDP command ${domain}.${command}: ${errorMessage}`);
    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
      electronProcess.cdpClient = undefined;
      electronProcess.cdpTargetId = undefined;
    }
    throw error;
  }
}

export { isDebugPortActive };
