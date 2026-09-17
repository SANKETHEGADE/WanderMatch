import pino from 'pino';
import { config } from '../config.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (config.env === 'production' ? 'info' : 'debug'),
  // Never log a bearer token, a photo body, or an API key, even by accident.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.apiKey',
      '*.password',
      '*.secretAccessKey'
    ],
    remove: true
  },
  transport: config.env === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined
});
