import pino from 'pino';
import settings from '../config/settings.mjs';

export default pino({ level: settings.logging.level }); 