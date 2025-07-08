import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./core/logger.js";
import {
    getElectronProcesses,
    manageApp,
    discoverApps
} from "./services/process-manager.js";
import { updateCDPTargets } from "./services/cdp-client.js";
import {
    capturePageSnapshot,
    executeScript,
    interactWithDom,
    inspectDom
} from "./services/dom-interactor.js";

// Inicializa o servidor MCP
const server = new Server(
  {
    name: "electron-debug-mcp",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {} // Apenas ferramentas nesta versão refatorada
    },
  }
);

// Handler para listar as ferramentas disponíveis
server.setRequestHandler(ListToolsRequestSchema, async () => {
  // A definição do schema das ferramentas permanece a mesma da versão anterior
  // para garantir a compatibilidade.
  return {
    tools: [
        {
            name: "manage_app",
            description: "Manages the lifecycle of an Electron application (start, connect, stop, reload).",
            inputSchema: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["start", "connect", "stop", "reload"] },
                    appPath: { type: "string", description: "Path to the Electron app (for 'start')." },
                    port: { type: "number", description: "Debug port (for 'connect' or 'start')." },
                    appId: { type: "string", description: "ID of the managed process (for 'stop' or 'reload')." },
                    reconnect: { type: "boolean", description: "Enable auto-reconnect on crash (for 'start')." }
                },
                required: ["action"]
            }
        },
        {
            name: "discover_apps",
            description: "Discovers running Electron applications.",
            inputSchema: {
                type: "object",
                properties: {
                    scope: { type: "string", enum: ["managed", "network", "all"], default: "all" }
                }
            }
        },
        {
            name: "interact_with_dom",
            description: "Simulates user interactions with a DOM element.",
            inputSchema: {
                type: "object",
                properties: {
                    appId: { type: "string" },
                    targetId: { type: "string" },
                    selector: { type: "string" },
                    action: { type: "string", enum: ["click", "double_click", "hover", "submit", "set_attribute", "type_text"] },
                    value: { type: "string", description: "Value for 'type_text' or 'set_attribute'." },
                    attribute: { type: "string", description: "Attribute name for 'set_attribute'." }
                },
                required: ["appId", "targetId", "selector", "action"]
            }
        },
        {
            name: "inspect_dom",
            description: "Inspects the DOM by getting the tree or verifying state.",
            inputSchema: {
                type: "object",
                properties: {
                    appId: { type: "string" },
                    targetId: { type: "string" },
                    query: { type: "string", enum: ["get_tree", "verify_state"] },
                    checks: { type: "array", items: { type: "object" }, description: "Array of checks for 'verify_state'." }
                },
                required: ["appId", "targetId", "query"]
            }
        },
        {
            name: "execute_script",
            description: "Executes a JavaScript expression in a target.",
            inputSchema: {
                type: "object",
                properties: {
                    appId: { type: "string" },
                    targetId: { type: "string" },
                    expression: { type: "string" },
                    options: { type: "object", description: "Advanced evaluation options." }
                },
                required: ["appId", "targetId", "expression"]
            }
        },
        {
           name: "get_logs",
           description: "Retrieves logs from the in-memory buffer for a specific application.",
           inputSchema: {
               type: "object",
               properties: {
                   appId: { type: "string", description: "ID of the managed process." },
                   clearBuffer: { type: "boolean", description: "If true, clears the log buffer after reading.", default: false }
               },
               required: ["appId"]
           }
        }
    ]
  };
});

// Handler para chamar as ferramentas
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const processes = getElectronProcesses();

  try {
    let result: any;

    // Garantir que args não é undefined antes de usá-lo
    if (!args) {
        throw new Error("Arguments for tool call are missing.");
    }

    const appId = (args as any).appId;
    const targetId = (args as any).targetId;
    const electronProcess = appId ? processes.get(appId) : undefined;

    if (appId && !electronProcess) {
        throw new Error(`Process with ID ${appId} not found.`);
    }

    switch (name) {
        case "manage_app":
            result = await manageApp(args as any);
            break;

        case "discover_apps":
            result = await discoverApps(args as any);
            break;

        case "interact_with_dom":
            if (!electronProcess || !targetId) throw new Error("appId and targetId are required.");
            result = await interactWithDom({ ...args, electronProcess, targetId } as any);
            break;

        case "inspect_dom":
            if (!electronProcess || !targetId) throw new Error("appId and targetId are required.");
            result = await inspectDom({ ...args, electronProcess, targetId } as any);
            break;

        case "execute_script":
            if (!electronProcess || !targetId) throw new Error("appId and targetId are required.");
            result = await executeScript(electronProcess, targetId, args.expression as string, args.options as any);
            break;


        case "get_logs":
           if (!electronProcess) throw new Error("appId is required.");
           // eslint-disable-next-line no-case-declarations
           const clearBuffer = (args as any).clearBuffer === true;
           result = [...(electronProcess.logBuffer || [])]; // Retorna uma cópia
           if (clearBuffer) {
               electronProcess.logBuffer = [];
               logger.info(`Log buffer cleared for process ${appId}.`);
           }
           break;

        default:
            throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Error calling tool ${name}: ${errorMessage}`);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true
    };
  }
});

// Conecta o servidor e inicia
async function main() {
    try {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        logger.info("Electron Debug MCP Server is running.");
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to start server: ${errorMessage}`);
        process.exit(1);
    }
}

main();