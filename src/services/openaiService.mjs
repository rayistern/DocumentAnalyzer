import OpenAI from 'openai';
import { OPENAI_SETTINGS, OPENAI_PROMPTS } from '../config/settings.mjs';
import { openAILogger as logger } from './loggingService.mjs';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function makeOpenAIRequest(messages, options = {}) {
    const startTime = Date.now();
    try {
        const request = {
            model: OPENAI_SETTINGS.model,
            messages,
            ...options
        };

        await logger.debug('Making OpenAI API request', { 
            model: request.model,
            messages: messages.map(m => ({ role: m.role, content_length: m.content.length }))
        });

        const response = await openai.chat.completions.create(request);

        const duration = Date.now() - startTime;
        await logger.logAPI('POST', 'chat/completions', request, {
            status: 200,
            data: response
        }, duration);

        return response;
    } catch (error) {
        const duration = Date.now() - startTime;
        await logger.logAPI('POST', 'chat/completions', {
            model: OPENAI_SETTINGS.model,
            messages
        }, {
            status: error.status || 500,
            data: error.response || error.message
        }, duration);
        throw error;
    }
}

export async function processFile(content, type, maxChunkLength = OPENAI_SETTINGS.defaultMaxChunkLength) {
    try {
        await logger.info('Starting file processing', { 
            type, 
            contentLength: content.length,
            maxChunkLength
        });

        let result;
        switch (type) {
            case 'sentiment':
                result = await analyzeSentiment(content);
                break;
            case 'chunk':
                result = await createChunks(content, maxChunkLength);
                break;
            default:
                result = await summarizeContent(content);
        }

        await logger.info('File processing completed', { 
            type, 
            resultSize: JSON.stringify(result).length,
            result // Log the complete result
        });
        return result;
    } catch (error) {
        await logger.error('File processing failed', error, { type });
        throw error;
    }
}

async function createChunks(text, maxChunkLength) {
    try {
        await logger.debug('Creating chunks', { textLength: text.length, maxChunkLength });

        const messages = [
            {
                role: OPENAI_PROMPTS.chunk.role,
                content: OPENAI_PROMPTS.chunk.content(maxChunkLength)
            },
            {
                role: "user",
                content: text
            }
        ];

        const response = await makeOpenAIRequest(messages);
        const result = JSON.parse(response.choices[0].message.content);

        await logger.debug('Raw LLM response', {
            raw_response: response.choices[0].message.content,
            parsed_result: result
        });

        if (result.chunks && result.textToRemove) {
            result.chunks = result.chunks.map(chunk => ({
                ...chunk,
                originalText: text.slice(chunk.startIndex - 1, chunk.endIndex)
            }));
        }

        const warnings = validateChunks(result.chunks, text);
        if (warnings.length > 0) {
            await logger.warning('Validation warnings found', { warnings });
        }

        result.warnings = warnings;
        return result;
    } catch (error) {
        await logger.error('Chunk creation failed', error);
        throw new Error(`Chunk creation failed: ${error.message}`);
    }
}

async function summarizeContent(text) {
    try {
        await logger.debug('Summarizing content', { textLength: text.length });

        const messages = [
            OPENAI_PROMPTS.summarize,
            {
                role: "user",
                content: text
            }
        ];

        const response = await makeOpenAIRequest(messages);
        const result = JSON.parse(response.choices[0].message.content);

        await logger.debug('Raw LLM response', {
            raw_response: response.choices[0].message.content,
            parsed_result: result
        });

        return result;
    } catch (error) {
        await logger.error('Summarization failed', error);
        throw new Error(`Summarization failed: ${error.message}`);
    }
}

async function analyzeSentiment(text) {
    try {
        await logger.debug('Analyzing sentiment', { textLength: text.length });

        const messages = [
            OPENAI_PROMPTS.sentiment,
            {
                role: "user",
                content: text
            }
        ];

        const response = await makeOpenAIRequest(messages);
        const result = JSON.parse(response.choices[0].message.content);

        await logger.debug('Raw LLM response', {
            raw_response: response.choices[0].message.content,
            parsed_result: result
        });

        return result;
    } catch (error) {
        await logger.error('Sentiment analysis failed', error);
        throw new Error(`Sentiment analysis failed: ${error.message}`);
    }
}

function validateChunks(chunks, originalText) {
    const warnings = [];
    let previousEndIndex = 0;

    chunks.forEach((chunk, index) => {
        if (chunk.startIndex !== previousEndIndex + 1 && index > 0) {
            const gapText = originalText.slice(previousEndIndex, chunk.startIndex - 1);
            const warning = `Gap detected between chunk ${index} and ${index + 1}. Gap content: "${gapText}"`;
            warnings.push(warning);
            logger.warning(warning, { chunkIndex: index });
        }

        const chunkText = originalText.slice(chunk.startIndex - 1, chunk.endIndex);
        if (!chunkText.trim().match(/[.!?]$/)) {
            const warning = `Chunk ${index + 1} does not end with a sentence break: "${chunkText}"`;
            warnings.push(warning);
            logger.warning(warning, { chunkIndex: index });
        }

        const chunkLength = chunk.endIndex - chunk.startIndex + 1;
        if (chunkLength > OPENAI_SETTINGS.defaultMaxChunkLength) {
            const warning = `Chunk ${index + 1} exceeds maximum length (${chunkLength} > ${OPENAI_SETTINGS.defaultMaxChunkLength})`;
            warnings.push(warning);
            logger.warning(warning, { chunkIndex: index, chunkLength });
        }

        previousEndIndex = chunk.endIndex;
    });

    if (previousEndIndex < originalText.length) {
        const remainingText = originalText.slice(previousEndIndex);
        const warning = `Unprocessed text remaining: "${remainingText}"`;
        warnings.push(warning);
        logger.warning(warning, { remainingLength: remainingText.length });
    }

    return warnings;
}