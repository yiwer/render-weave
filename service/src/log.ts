/** 结构化日志：每行一个 JSON 对象，带服务名与构建标识；请求头里的凭据不进日志。 */
import { pino, stdTimeFunctions, type DestinationStream, type Logger } from 'pino';

export type { Logger };

export function createLogger(service: 'api' | 'worker' | 'setup', build: string, level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service, build },
    timestamp: stdTimeFunctions.isoTime,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
  };
  return destination ? pino(options, destination) : pino(options);
}
