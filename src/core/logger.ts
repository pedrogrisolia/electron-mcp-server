/**
 * Módulo de log centralizado para o servidor MCP.
 * Permite diferentes níveis de log e saídas configuráveis.
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

class Logger {
  private static instance: Logger;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private log(level: LogLevel, message: string, ...args: any[]) {
    if (process.env.MCP_LOG_LEVEL === 'silent') return;
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    // MCP stdio transport uses stdout for JSON-RPC only — always log to stderr.
    const logFn = level === 'error' || level === 'warn' ? console.error : console.error;
    if (args.length > 0) {
      logFn(formattedMessage, ...args);
    } else {
      logFn(formattedMessage);
    }
  }

  public info(message: string, ...args: any[]) {
    this.log('info', message, ...args);
  }

  public warn(message: string, ...args: any[]) {
    this.log('warn', message, ...args);
  }

  public error(message: string, ...args: any[]) {
    this.log('error', message, ...args);
  }

  public debug(message: string, ...args: any[]) {
    // O log de debug pode ser condicional no futuro (ex: variável de ambiente)
    this.log('debug', message, ...args);
  }
}

export const logger = Logger.getInstance();