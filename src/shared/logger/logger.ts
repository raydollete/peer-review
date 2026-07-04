import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';

export interface ILogger {
  readonly info: (message: string, context?: Record<string, unknown>) => void;
  readonly error: (message: string, context?: Record<string, unknown>) => void;
  readonly warn: (message: string, context?: Record<string, unknown>) => void;
  readonly debug: (message: string, context?: Record<string, unknown>) => void;
}

export function createLogger(level: string): ILogger {
  // Logs MUST go to stderr — stdout is reserved for JSON-RPC frames on the stdio MCP transport.
  const pinoLogger: PinoLogger =
    process.env['NODE_ENV'] !== 'production'
      ? pino({
          level,
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, destination: 2 },
          },
        })
      : pino({ level }, pino.destination(2));

  return {
    info: (message, context): void => {
      pinoLogger.info(context ?? {}, message);
    },
    error: (message, context): void => {
      pinoLogger.error(context ?? {}, message);
    },
    warn: (message, context): void => {
      pinoLogger.warn(context ?? {}, message);
    },
    debug: (message, context): void => {
      pinoLogger.debug(context ?? {}, message);
    },
  };
}
