import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '../../logs');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB

export class Logger {
    constructor(serviceName) {
        this.serviceName = serviceName;
        this.logFile = path.join(LOG_DIR, `${serviceName}-${getCurrentDate()}.log`);
        this.ensureLogDirectory();
    }

    async ensureLogDirectory() {
        try {
            await fs.access(LOG_DIR);
        } catch {
            await fs.mkdir(LOG_DIR, { recursive: true });
        }
    }

    async rotateLogIfNeeded() {
        try {
            const stats = await fs.stat(this.logFile);
            if (stats.size > MAX_LOG_SIZE) {
                const newLogFile = path.join(LOG_DIR, `${this.serviceName}-${getCurrentDate()}-${Date.now()}.log`);
                await fs.rename(this.logFile, newLogFile);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.error('Error rotating log file:', error);
            }
        }
    }

    async log(level, message, data = {}) {
        await this.ensureLogDirectory();
        await this.rotateLogIfNeeded();

        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            service: this.serviceName,
            message,
            ...data
        };

        const logLine = JSON.stringify(logEntry) + '\n';

        try {
            await fs.appendFile(this.logFile, logLine, 'utf8');
            // Also log to console for development visibility
            if (level === 'error' || process.env.NODE_ENV !== 'production') {
                console.log(`[${this.serviceName}] ${message}`);
            }
        } catch (error) {
            console.error('Failed to write to log file:', error);
            throw error; // Propagate the error to handle it in the calling code
        }
    }

    async info(message, data = {}) {
        await this.log('info', message, data);
    }

    async error(message, error = null, data = {}) {
        const errorData = error ? {
            error: {
                name: error.name,
                message: error.message,
                stack: error.stack,
                ...(error.response && {
                    response: {
                        status: error.response.status,
                        statusText: error.response.statusText,
                        data: error.response.data
                    }
                })
            },
            ...data
        } : data;
        await this.log('error', message, errorData);
    }

    async warning(message, data = {}) {
        await this.log('warning', message, data);
    }

    async debug(message, data = {}) {
        if (process.env.NODE_ENV !== 'production') {
            await this.log('debug', message, data);
        }
    }

    // New method for logging API interactions
    async logAPI(method, endpoint, request, response, duration) {
        const apiLog = {
            method,
            endpoint,
            request: {
                ...request,
                headers: request.headers ? maskSensitiveData(request.headers) : undefined
            },
            response: {
                status: response.status,
                headers: response.headers,
                data: response.data
            },
            duration_ms: duration
        };
        await this.log('api', `API ${method} ${endpoint}`, apiLog);
    }
}

function getCurrentDate() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function maskSensitiveData(headers) {
    const maskedHeaders = { ...headers };
    const sensitiveKeys = ['authorization', 'api-key', 'x-api-key'];
    for (const key of Object.keys(maskedHeaders)) {
        if (sensitiveKeys.includes(key.toLowerCase())) {
            maskedHeaders[key] = '[REDACTED]';
        }
    }
    return maskedHeaders;
}

// Create and export default loggers for each service
export const openAILogger = new Logger('openai-service');
export const storageLogger = new Logger('storage-service');
export const systemLogger = new Logger('system');