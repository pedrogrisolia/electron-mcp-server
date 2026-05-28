import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './core/logger.js';
import { getElectronProcesses, manageApp, discoverApps } from './services/process-manager.js';
import { executeScript, interactWithDom, inspectDom } from './services/dom-interactor.js';

export function createMcpServer(): Server {
  const server = new Server(
    {
      name: 'electron-debug-mcp',
      version: '2.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'manage_app',
        description: 'Manages the lifecycle of an Electron application (start, connect, stop, reload).',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['start', 'connect', 'stop', 'reload'] },
            appPath: { type: 'string', description: "Path to the Electron app (for 'start')." },
            port: { type: 'number', description: "Debug port (for 'connect' or 'start')." },
            appId: { type: 'string', description: "ID of the managed process (for 'stop' or 'reload')." },
            targetId: { type: 'string', description: "CDP page target to reload (for 'reload' on external apps)." },
            reconnect: { type: 'boolean', description: "Enable auto-reconnect on crash (for 'start')." },
          },
          required: ['action'],
        },
      },
      {
        name: 'discover_apps',
        description: 'Discovers running Electron applications.',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['managed', 'network', 'all'], default: 'all' },
          },
        },
      },
      {
        name: 'interact_with_dom',
        description: 'Simulates user interactions with a DOM element.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            targetId: { type: 'string' },
            selector: { type: 'string' },
            action: {
              type: 'string',
              enum: ['click', 'double_click', 'hover', 'submit', 'set_attribute', 'type_text'],
            },
            value: { type: 'string', description: "Value for 'type_text' or 'set_attribute'." },
            attribute: { type: 'string', description: "Attribute name for 'set_attribute'." },
          },
          required: ['appId', 'targetId', 'selector', 'action'],
        },
      },
      {
        name: 'inspect_dom',
        description: 'Inspects the DOM by getting the tree or verifying state.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            targetId: { type: 'string' },
            query: { type: 'string', enum: ['get_tree', 'verify_state'] },
            checks: { type: 'array', items: { type: 'object' }, description: "Array of checks for 'verify_state'." },
          },
          required: ['appId', 'targetId', 'query'],
        },
      },
      {
        name: 'execute_script',
        description: 'Executes a JavaScript expression in a target.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string' },
            targetId: { type: 'string' },
            expression: { type: 'string' },
            options: { type: 'object', description: 'Advanced evaluation options.' },
          },
          required: ['appId', 'targetId', 'expression'],
        },
      },
      {
        name: 'get_logs',
        description: 'Retrieves logs from the in-memory buffer for a specific application.',
        inputSchema: {
          type: 'object',
          properties: {
            appId: { type: 'string', description: 'ID of the managed process.' },
            clearBuffer: { type: 'boolean', description: 'If true, clears the log buffer after reading.', default: false },
          },
          required: ['appId'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const processes = getElectronProcesses();

    try {
      if (!args) {
        throw new Error('Arguments for tool call are missing.');
      }

      const appId = (args as { appId?: string }).appId;
      const targetId = (args as { targetId?: string }).targetId;
      const electronProcess = appId ? processes.get(appId) : undefined;

      if (appId && !electronProcess) {
        throw new Error(`Process with ID ${appId} not found.`);
      }

      let result: unknown;

      switch (name) {
        case 'manage_app':
          result = await manageApp(args as Parameters<typeof manageApp>[0]);
          break;
        case 'discover_apps':
          result = await discoverApps(args as Parameters<typeof discoverApps>[0]);
          break;
        case 'interact_with_dom':
          if (!electronProcess || !targetId) throw new Error('appId and targetId are required.');
          result = await interactWithDom({ ...args, electronProcess, targetId } as Parameters<typeof interactWithDom>[0]);
          break;
        case 'inspect_dom':
          if (!electronProcess || !targetId) throw new Error('appId and targetId are required.');
          result = await inspectDom({ ...args, electronProcess, targetId } as Parameters<typeof inspectDom>[0]);
          break;
        case 'execute_script':
          if (!electronProcess || !targetId) throw new Error('appId and targetId are required.');
          result = await executeScript(
            electronProcess,
            targetId,
            (args as { expression: string }).expression,
            (args as { options?: object }).options as Parameters<typeof executeScript>[3]
          );
          break;
        case 'get_logs': {
          if (!electronProcess) throw new Error('appId is required.');
          const clearBuffer = (args as { clearBuffer?: boolean }).clearBuffer === true;
          result = [...(electronProcess.logBuffer || [])];
          if (clearBuffer) {
            electronProcess.logBuffer = [];
            logger.info(`Log buffer cleared for process ${appId}.`);
          }
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Error calling tool ${name}: ${errorMessage}`);
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  return server;
}
