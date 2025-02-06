import fs from 'fs/promises';
import path from 'path';

const LOG_DIR = 'logs';

export async function initLogging() {
    try {
        await fs.mkdir(LOG_DIR, { recursive: true });
    } catch (error) {
        console.error('Failed to create log directory:', error);
    }
}

export async function logChunkValidation(chunkIndex, details) {
    const timestamp = new Date().toISOString();
    const logFileName = path.join(LOG_DIR, `chunk_validation_${timestamp.split('T')[0]}.log`);

    const logEntry = {
        timestamp,
        chunkIndex,
        ...details,
        validation: {
            chunkLength: details.length,
            endsWithSentence: details.endsWithSentence,
            wordBoundariesMatch: details.actual.first === details.expected.first && 
                                details.actual.last === details.expected.last,
            contextBefore: details.context.before,
            contextAfter: details.context.after
        }
    };

    try {
        await fs.appendFile(
            logFileName,
            JSON.stringify(logEntry, null, 2) + '\n---\n',
            'utf8'
        );
    } catch (error) {
        console.error('Failed to write validation log:', error);
    }
}

export async function logOpenAIResponse(prompt, response) {
    const timestamp = new Date().toISOString();
    const logFileName = path.join(LOG_DIR, `openai_${timestamp.split('T')[0]}.log`);

    const logEntry = {
        timestamp,
        prompt,
        modelResponse: {
            model: response.model,
            content: response.choices[0].message.content,
            finishReason: response.choices[0].finish_reason,
            usage: response.usage
        }
    };

    try {
        await fs.appendFile(
            logFileName,
            JSON.stringify(logEntry, null, 2) + '\n---\n',
            'utf8'
        );
    } catch (error) {
        console.error('Failed to write OpenAI log:', error);
    }
}