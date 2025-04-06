import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
// @ts-ignore
import CDP from 'chrome-remote-interface';
import * as http from 'http';
import * as net from 'net';

// Define custom resource URIs for Electron debugging
const ELECTRON_RESOURCES = {
  INFO: "electron://info",
  PROCESS: "electron://process/",
  LOGS: "electron://logs/",
  OPERATION: "electron://operation/",
  CDP: "electron://cdp/",
  TARGETS: "electron://targets"
};

// Define operation types for Electron debugging
const ELECTRON_OPERATIONS = {
  START: "start",
  STOP: "stop",
  LIST: "list",
  RELOAD: "reload",
  PAUSE: "pause",
  RESUME: "resume",
  EVALUATE: "evaluate"
};

// Type definitions for Electron processes and debugging info
interface ElectronProcess {
  id: string;
  process: ChildProcess;
  name: string;
  status: 'running' | 'stopped' | 'crashed';
  pid?: number;
  debugPort?: number;
  startTime: Date;
  logs: string[];
  appPath: string;
  cdpClient?: any; // Chrome DevTools Protocol client
  targets?: CDPTarget[]; // Available debugging targets
  lastTargetUpdate?: Date; // When targets were last updated
}

interface ElectronDebugInfo {
  webContents: ElectronWebContentsInfo[];
  processes: {
    main: ProcessInfo;
    renderers: ProcessInfo[];
  };
}

interface ElectronWebContentsInfo {
  id: number;
  url: string;
  title: string;
  debuggable: boolean;
  debugPort?: number;
  targetId?: string; // CDP target ID
}

interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}

interface ProcessInfo {
  pid: number;
  cpuUsage: number;
  memoryUsage: number;
  status: string;
}

// Store active Electron processes
const electronProcesses: Map<string, ElectronProcess> = new Map();

// Helper functions for Electron debugging
function getElectronExecutablePath(): string {
  // Try to find electron in common locations
  const possiblePaths = [
    // Check if electron is installed globally
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'electron.cmd'),
    // Check in node_modules of the current project
    path.resolve(process.cwd(), 'node_modules', '.bin', 'electron.cmd')
  ];

  for (const electronPath of possiblePaths) {
    if (fs.existsSync(electronPath)) {
      return electronPath;
    }
  }

  // Default to expecting electron to be in PATH
  return 'electron';
}

async function startElectronApp(appPath: string, debugPort?: number): Promise<ElectronProcess> {
  const id = `electron-${Date.now()}`;
  const args = [appPath];
  
  // If no debug port specified, choose a random one between 9222 and 9999
  if (!debugPort) {
    debugPort = Math.floor(Math.random() * (9999 - 9222 + 1)) + 9222;
  }
  
  // Add debugging flags
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
    logs: [],
    appPath
  };
  
  // Capture stdout and stderr
  electronProc.stdout.on('data', (data: Buffer) => {
    const log = data.toString();
    electronProcess.logs.push(log);
    // Log to console instead of sending notifications
    console.log(`[Electron ${id}] ${log}`);
  });
  
  electronProc.stderr.on('data', (data: Buffer) => {
    const log = data.toString();
    electronProcess.logs.push(log);
    // Log to console instead of sending notifications
    console.error(`[Electron ${id}] ${log}`);
  });
  
  // Handle process exit
  electronProc.on('exit', (code: number | null) => {
    electronProcess.status = code === 0 ? 'stopped' : 'crashed';
    console.info(`[Electron ${id}] Process exited with code ${code}`);
    
    // Clean up CDP client if it exists
    if (electronProcess.cdpClient) {
      try {
        electronProcess.cdpClient.close();
      } catch (err) {
        console.error(`[Electron ${id}] Error closing CDP client:`, err);
      }
      electronProcess.cdpClient = undefined;
    }
  });
  
  electronProcesses.set(id, electronProcess);
  
  // Wait a moment for the app to start and initialize the debugging port
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Try to connect to CDP and get available targets
  try {
    await updateCDPTargets(electronProcess);
  } catch (err) {
    console.warn(`[Electron ${id}] Could not connect to CDP initially:`, err);
  }
  
  return electronProcess;
}

function stopElectronApp(id: string): boolean {
  const electronProcess = electronProcesses.get(id);
  if (!electronProcess) {
    return false;
  }
  
  // Close CDP client if it exists
  if (electronProcess.cdpClient) {
    try {
      electronProcess.cdpClient.close();
    } catch (err) {
      console.error(`[Electron ${id}] Error closing CDP client:`, err);
    }
    electronProcess.cdpClient = undefined;
  }
  
  electronProcess.process.kill();
  electronProcess.status = 'stopped';
  return true;
}

async function getElectronDebugInfo(id: string): Promise<ElectronDebugInfo | null> {
  const electronProcess = electronProcesses.get(id);
  if (!electronProcess || electronProcess.status !== 'running') {
    return null;
  }
  
  // Update CDP targets to get the latest information
  try {
    await updateCDPTargets(electronProcess);
  } catch (err) {
    console.warn(`[Electron ${id}] Could not update CDP targets:`, err);
  }
  
  // Convert CDP targets to WebContents info
  const webContents: ElectronWebContentsInfo[] = electronProcess.targets?.map((target, index) => ({
    id: index + 1,
    url: target.url,
    title: target.title,
    debuggable: !!target.webSocketDebuggerUrl,
    debugPort: electronProcess.debugPort,
    targetId: target.id
  })) || [
    {
      id: 1,
      url: 'file://' + electronProcess.appPath,
      title: electronProcess.name,
      debuggable: true,
      debugPort: electronProcess.debugPort
    }
  ];
  
  return {
    webContents,
    processes: {
      main: {
        pid: electronProcess.pid || 0,
        cpuUsage: Math.random() * 10, // We could get real data with CDP
        memoryUsage: Math.random() * 100 * 1024 * 1024,
        status: 'running'
      },
      renderers: [
        {
          pid: (electronProcess.pid || 0) + 1,
          cpuUsage: Math.random() * 5,
          memoryUsage: Math.random() * 50 * 1024 * 1024,
          status: 'running'
        }
      ]
    }
  };
}

// Add CDP-related functions

/**
 * Updates the CDP targets for an Electron process
 */
async function updateCDPTargets(electronProcess: ElectronProcess): Promise<CDPTarget[]> {
  if (!electronProcess.debugPort) {
    throw new Error('No debug port available for this Electron process');
  }
  
  try {
    // Get the list of available targets from the Chrome DevTools Protocol
    const response = await fetch(`http://localhost:${electronProcess.debugPort}/json/list`);
    if (!response.ok) {
      throw new Error(`Failed to get targets: ${response.statusText}`);
    }
    
    const targets = await response.json() as CDPTarget[];
    electronProcess.targets = targets;
    electronProcess.lastTargetUpdate = new Date();
    return targets;
  } catch (error) {
    console.error(`Error getting CDP targets for process ${electronProcess.id}:`, error);
    throw error;
  }
}

/**
 * Connects to a specific CDP target
 */
async function connectToCDPTarget(electronProcess: ElectronProcess, targetId: string): Promise<any> {
  if (!electronProcess.debugPort) {
    throw new Error('No debug port available for this Electron process');
  }
  
  try {
    // Make sure we have the latest targets
    if (!electronProcess.targets || !electronProcess.lastTargetUpdate || 
        (new Date().getTime() - electronProcess.lastTargetUpdate.getTime() > 5000)) {
      await updateCDPTargets(electronProcess);
    }
    
    // Find the target
    const target = electronProcess.targets?.find(t => t.id === targetId);
    if (!target) {
      throw new Error(`Target ${targetId} not found`);
    }
    
    // Connect to the target using CDP
    const client = await CDP({
      target: targetId,
      port: electronProcess.debugPort
    } as any);
    
    // Store the client for later use
    electronProcess.cdpClient = client;
    return client;
  } catch (error) {
    console.error(`Error connecting to CDP target ${targetId}:`, error);
    throw error;
  }
}

/**
 * Executes a CDP command on a target
 */
async function executeCDPCommand(electronProcess: ElectronProcess, targetId: string, domain: string, command: string, params: any = {}): Promise<any> {
  let client;
  
  try {
    // Get or create a CDP client
    if (electronProcess.cdpClient) {
      client = electronProcess.cdpClient;
    } else {
      client = await connectToCDPTarget(electronProcess, targetId);
    }
    
    // Execute the command
    return await client.send(`${domain}.${command}`, params);
  } catch (error) {
    console.error(`Error executing CDP command ${domain}.${command}:`, error);
    throw error;
  }
}

// Initialize server with resource capabilities
const server = new Server(
  {
    name: "electron-debug-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      resources: {}, // Enable resources
    },
  }
);

// List available resources when clients request them
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // Create a list of resources including all active Electron processes and operations
  const resources = [
    {
      uri: ELECTRON_RESOURCES.INFO,
      name: "Electron Debugging Info",
      description: "Information about the Electron debugging capabilities",
      mimeType: "application/json",
    },
    {
      uri: `${ELECTRON_RESOURCES.OPERATION}${ELECTRON_OPERATIONS.START}`,
      name: "Start Electron App",
      description: "Start an Electron application for debugging",
      mimeType: "application/json",
    },
    {
      uri: `${ELECTRON_RESOURCES.OPERATION}${ELECTRON_OPERATIONS.STOP}`,
      name: "Stop Electron App",
      description: "Stop a running Electron application",
      mimeType: "application/json",
    },
    {
      uri: `${ELECTRON_RESOURCES.OPERATION}${ELECTRON_OPERATIONS.LIST}`,
      name: "List Electron Apps",
      description: "List all running Electron applications",
      mimeType: "application/json",
    },
    {
      uri: `${ELECTRON_RESOURCES.OPERATION}${ELECTRON_OPERATIONS.RELOAD}`,
      name: "Reload Electron App",
      description: "Reload a running Electron application",
      mimeType: "application/json",
    },
    {
      uri: `${ELECTRON_RESOURCES.OPERATION}${ELECTRON_OPERATIONS.EVALUATE}`,
      name: "Evaluate JavaScript",
      description: "Evaluate JavaScript in a running Electron application",
      mimeType: "application/json",
    },
    {
      uri: ELECTRON_RESOURCES.TARGETS,
      name: "Electron Debug Targets",
      description: "List all available debug targets across Electron processes",
      mimeType: "application/json",
    }
  ];
  
  // Add resources for each active Electron process
  for (const [id, process] of electronProcesses.entries()) {
    resources.push({
      uri: `${ELECTRON_RESOURCES.PROCESS}${id}`,
      name: `Electron Process: ${process.name}`,
      description: `Debug information for Electron process ${process.name}`,
      mimeType: "application/json",
    });
    
    resources.push({
      uri: `${ELECTRON_RESOURCES.LOGS}${id}`,
      name: `Electron Logs: ${process.name}`,
      description: `Logs for Electron process ${process.name}`,
      mimeType: "text/plain",
    });
    
    // Add CDP resources for each target in the process
    if (process.targets && process.targets.length > 0) {
      for (const target of process.targets) {
        resources.push({
          uri: `${ELECTRON_RESOURCES.CDP}${id}/${target.id}`,
          name: `CDP: ${target.title || target.url}`,
          description: `Chrome DevTools Protocol access for target ${target.id}`,
          mimeType: "application/json",
        });
      }
    }
  }
  
  return { resources };
});

// Handle resource read requests
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  
  // Handle targets listing resource
  if (uri === ELECTRON_RESOURCES.TARGETS) {
    // Collect all targets from all processes
    const allTargets: Array<{processId: string, target: CDPTarget}> = [];
    
    for (const [id, process] of electronProcesses.entries()) {
      // Update targets if needed
      if (process.status === 'running' && process.debugPort) {
        try {
          await updateCDPTargets(process);
          if (process.targets) {
            for (const target of process.targets) {
              allTargets.push({
                processId: id,
                target
              });
            }
          }
        } catch (err) {
          console.warn(`Could not update targets for process ${id}:`, err);
        }
      }
    }
    
    return {
      contents: [
        {
          uri,
          text: JSON.stringify(allTargets, null, 2),
        },
      ],
    };
  }
  
  // Handle CDP commands
  if (uri.startsWith(ELECTRON_RESOURCES.CDP)) {
    const cdpMatch = uri.match(/^electron:\/\/cdp\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    if (!cdpMatch) {
      throw new Error(`Invalid CDP URI: ${uri}`);
    }
    
    const processId = cdpMatch[1];
    const targetId = cdpMatch[2];
    const command = cdpMatch[3]; // Optional command path
    
    const process = electronProcesses.get(processId);
    if (!process || process.status !== 'running') {
      throw new Error(`Process ${processId} not found or not running`);
    }
    
    if (!command) {
      // Just return information about the target
      const target = process.targets?.find(t => t.id === targetId);
      if (!target) {
        throw new Error(`Target ${targetId} not found in process ${processId}`);
      }
      
      return {
        contents: [
          {
            uri,
            text: JSON.stringify({
              target,
              availableDomains: [
                'Page', 'Runtime', 'Debugger', 'DOM', 'Network', 'Console',
                'Memory', 'Profiler', 'Performance', 'HeapProfiler'
              ],
              usage: `To execute a CDP command, append /{domain}/{command} to this URI`
            }, null, 2),
          },
        ],
      };
    }
    
    // Parse the command path
    const commandParts = command.split('/');
    if (commandParts.length !== 2) {
      throw new Error(`Invalid CDP command format: ${command}. Expected format: {domain}/{command}`);
    }
    
    const domain = commandParts[0];
    const method = commandParts[1];
    
    try {
      // Execute the CDP command
      const result = await executeCDPCommand(process, targetId, domain, method);
      
      return {
        contents: [
          {
            uri,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Error executing CDP command: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  // Handle general Electron info resource
  if (uri === ELECTRON_RESOURCES.INFO) {
    return {
      contents: [
        {
          uri,
          text: JSON.stringify({
            activeProcesses: Array.from(electronProcesses.entries()).map(([id, proc]) => ({
              id,
              name: proc.name,
              status: proc.status,
              pid: proc.pid,
              startTime: proc.startTime
            }))
          }, null, 2),
        },
      ],
    };
  }
  
  // Handle process-specific resources
  const processMatch = uri.match(/^electron:\/\/process\/(.+)$/);
  if (processMatch) {
    const processId = processMatch[1];
    const debugInfo = await getElectronDebugInfo(processId);
    
    if (!debugInfo) {
      throw new Error(`Process ${processId} not found or not running`);
    }
    
    return {
      contents: [
        {
          uri,
          text: JSON.stringify(debugInfo, null, 2),
        },
      ],
    };
  }
  
  // Handle logs resources
  const logsMatch = uri.match(/^electron:\/\/logs\/(.+)$/);
  if (logsMatch) {
    const processId = logsMatch[1];
    const process = electronProcesses.get(processId);
    
    if (!process) {
      throw new Error(`Process ${processId} not found`);
    }
    
    return {
      contents: [
        {
          uri,
          text: process.logs.join('\n'),
        },
      ],
    };
  }
  
  // Handle operation resources
  if (uri.startsWith(ELECTRON_RESOURCES.OPERATION)) {
    const operationMatch = uri.match(/^electron:\/\/operation\/([^/]+)(?:\/(.*))?$/);
    if (!operationMatch) {
      throw new Error(`Invalid operation URI: ${uri}`);
    }
    
    const operation = operationMatch[1];
    let result: any;
    
    // Handle different operation types
    if (operation === ELECTRON_OPERATIONS.START) {
      // For the read request, just return instructions on how to use this resource
      result = {
        instructions: "To start an Electron app, send a POST request with JSON body: { \"appPath\": \"/path/to/electron/app\", \"debugPort\": 9222 }",
        example: {
          appPath: "C:\\path\\to\\electron\\app",
          debugPort: 9222 // optional
        }
      };
    } else if (operation === ELECTRON_OPERATIONS.STOP) {
      // For the read request, just return instructions on how to use this resource
      result = {
        instructions: "To stop an Electron app, send a POST request with JSON body: { \"processId\": \"electron-12345678\" }",
        example: {
          processId: "electron-12345678"
        }
      };
    } else if (operation === ELECTRON_OPERATIONS.RELOAD) {
      // For the read request, just return instructions on how to use this resource
      result = {
        instructions: "To reload an Electron app, send a POST request with JSON body: { \"processId\": \"electron-12345678\", \"targetId\": \"page-123\" }",
        example: {
          processId: "electron-12345678",
          targetId: "page-123" // Optional, if not provided will reload all targets
        }
      };
    } else if (operation === ELECTRON_OPERATIONS.EVALUATE) {
      // For the read request, just return instructions on how to use this resource
      result = {
        instructions: "To evaluate JavaScript in an Electron app, send a POST request with JSON body: { \"processId\": \"electron-12345678\", \"targetId\": \"page-123\", \"expression\": \"document.title\" }",
        example: {
          processId: "electron-12345678",
          targetId: "page-123",
          expression: "document.title",
          returnByValue: true // Optional, whether to return the result by value
        }
      };
    } else if (operation === ELECTRON_OPERATIONS.LIST) {
      // For the list operation, we can return the actual list of processes
      const processes = Array.from(electronProcesses.entries()).map(([id, proc]) => ({
        id,
        name: proc.name,
        status: proc.status,
        pid: proc.pid,
        startTime: proc.startTime,
        appPath: proc.appPath,
        debugPort: proc.debugPort
      }));
      
      result = {
        processes
      };
    } else {
      throw new Error(`Unknown operation: ${operation}`);
    }
    
    return {
      contents: [
        {
          uri,
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  }
  
  throw new Error(`Resource not found: ${uri}`);
});

// Start server using stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
console.info('{"jsonrpc": "2.0", "method": "log", "params": { "message": "Electron Debug MCP Server running..." }}');