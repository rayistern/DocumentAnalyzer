import OpenAI from 'openai';
import { openAILogger as logger } from './loggingService.mjs';
import { logLLMResponse } from './dbService.mjs';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export async function processFile(content, type, documentId = null) {
    const startTime = Date.now();
    try {
        let result;
        if (type === 'sentiment') {
            result = await analyzeSentiment(content);
        } else {
            result = await summarizeContent(content);
        }

        const processingTime = Date.now() - startTime;

        // Log to both file and database
        await logger.info('OpenAI processing completed', {
            type,
            processingTime,
            contentLength: content.length,
            response: result
        });

        await logLLMResponse({
            requestType: type,
            inputText: content,
            response: result,
            model: "gpt-4o",
            processingTime,
            documentId,
            status: 'success'
        });

        return result;
    } catch (error) {
        const processingTime = Date.now() - startTime;

        await logger.error('OpenAI processing failed', error, {
            type,
            processingTime,
            contentLength: content.length
        });

        // Log failed attempts as well
        await logLLMResponse({
            requestType: type,
            inputText: content,
            response: { error: error.message },
            model: "gpt-4o",
            processingTime,
            documentId,
            status: 'error'
        });

        throw new Error(`OpenAI processing failed: ${error.message}`);
    }
}

async function summarizeContent(text) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "Summarize the following text and provide the result in JSON format with 'summary' and 'keyPoints' fields."
                },
                {
                    role: "user",
                    content: text
                }
            ],
            response_format: { type: "json_object" }
        });

        return response.choices[0].message.content;
    } catch (error) {
        throw new Error(`Summarization failed: ${error.message}`);
    }
}

async function analyzeSentiment(text) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "Analyze the sentiment of the text and provide a JSON response with 'sentiment' (positive/negative/neutral), 'score' (1-5), and 'confidence' (0-1) fields."
                },
                {
                    role: "user",
                    content: text
                }
            ],
            response_format: { type: "json_object" }
        });

        return response.choices[0].message.content;
    } catch (error) {
        throw new Error(`Sentiment analysis failed: ${error.message}`);
    }
}