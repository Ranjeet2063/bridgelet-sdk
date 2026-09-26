import { Injectable, LoggerService } from '@nestjs/common';
import * as crypto from 'crypto';
import { getRequestId } from '../context/request-context.js';
import appConfig from '../../config/app.config.js';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  level: LogLevel;
  time: string;
  service: string;
  env: string;
  traceId: string;
  context?: string;
  msg: string;
  stack?: string;
}

const SECRET_PATTERN =
  /\b[SG][A-Z0-9]{54,55}\b|(?:secret|private_?key|secretkey)\s*[:=]\s*\S+/gi;

function redact(msg: string): string {
  return msg.replace(SECRET_PATTERN, '[REDACTED]');
}

@Injectable()
export class PinoLoggerService implements LoggerService {
  private readonly service = 'bridgelet-sdk';
  private readonly env = appConfig().env;

  private write(level: LogLevel, message: unknown, context?: string): void {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    const entry: LogEntry = {
      level,
      time: new Date().toISOString(),
      service: this.service,
      env: this.env,
      traceId: this.currentTraceId(),
      context,
      msg: redact(raw),
    };
    // Remove undefined keys so JSON output stays clean
    if (!entry.context) delete entry.context;
    process.stdout.write(JSON.stringify(entry) + '\n');
  }

  private writeError(message: unknown, stack?: string, context?: string): void {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    const entry: LogEntry = {
      level: 'error',
      time: new Date().toISOString(),
      service: this.service,
      env: this.env,
      traceId: this.currentTraceId(),
      context,
      msg: redact(raw),
      stack,
    };
    if (!entry.context) delete entry.context;
    if (!entry.stack) delete entry.stack;
    process.stderr.write(JSON.stringify(entry) + '\n');
  }

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.writeError(message, stack, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('trace', message, context);
  }

  fatal(message: unknown, context?: string): void {
    this.write('fatal', message, context);
  }

  private currentTraceId(): string {
    return getRequestId() ?? crypto.randomUUID();
  }
}
