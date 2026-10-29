import { Injectable, LoggerService } from '@nestjs/common';
import { stringifyCommerce } from './money';

const REDACTED = '[REDACTED]';
const SENSITIVE = /password|token|secret|authorization|cookie|credential|bearer|connection(string)?|sql|parameter|payment|card|cvv|api.?key/i;
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]*@/i;
function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return SENSITIVE.test(value) || CREDENTIAL_URL.test(value) ? REDACTED : value;
  // Error properties/stacks can contain driver SQL, parameters or opaque credentials.
  if (value instanceof Error) return { type: 'Error', detail: REDACTED };
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'; seen.add(value);
    if (Array.isArray(value)) return value.map(item => sanitize(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE.test(key) ? REDACTED : sanitize(item, seen)]));
  }
  return value;
}

@Injectable()
export class SafeLogger implements LoggerService {
  log(message: unknown, context?: string): void { this.write('info', message, context); }
  error(message: unknown, trace?: string, context?: string): void { this.write('error', message, context, trace); }
  warn(message: unknown, context?: string): void { this.write('warn', message, context); }
  debug(message: unknown, context?: string): void { this.write('debug', message, context); }
  verbose(message: unknown, context?: string): void { this.write('debug', message, context); }
  private write(level: string, message: unknown, context?: string, trace?: string): void {
    const record = { timestamp: new Date().toISOString(), level, context: sanitize(context), message: sanitize(message), ...(trace ? { trace: REDACTED } : {}) };
    process.stdout.write(`${stringifyCommerce(record)}\n`);
  }
}
