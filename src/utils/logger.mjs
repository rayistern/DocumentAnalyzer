import pino from 'pino';
import settings from '../config/settings.mjs';

const logger = pino({ level: settings.logging.level });

export default logger;
export { logger }; 