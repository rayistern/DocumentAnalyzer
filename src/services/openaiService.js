import OpenAI from 'openai';
import { db } from '../db.js';
import { llmLogs } from '../schema.js';
import { OPENAI_SETTINGS, OPENAI_PROMPTS } from '../config/settings.mjs';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function logLLMInteraction(documentId, requestType, prompt, response, tokens, duration) {
    try {
        await db.insert(llmLogs).values({
            documentId,
            requestType,
            prompt: JSON.stringify(prompt),
            response: JSON.stringify(response), 
            tokens,
            duration
        });
    } catch (error) {
        console.error('Failed to log LLM interaction:', error);
    }
}

export async function processFile(content, type, documentId) {
    const startTime = Date.now();
    let response, prompt;

    try {
        if (type === 'sentiment') {
            prompt = OPENAI_PROMPTS.sentiment;
            response = await analyzeSentiment(content);
        } else {
            prompt = OPENAI_PROMPTS.summarize;
            response = await summarizeContent(content);
        }

        const duration = Date.now() - startTime;
        await logLLMInteraction(
            documentId,
            type,
            prompt,
            response,
            response.usage.total_tokens,
            duration
        );

        return response;
    } catch (error) {
        console.error('Processing failed:', error);
        throw error;
    }
}

async function summarizeContent(text) {
    const response = await openai.chat.completions.create({
        model: OPENAI_SETTINGS.model,
        messages: [
            {
                role: "system",
                content: OPENAI_PROMPTS.summarize.content
            },
            {
                role: "user",
                content: text
            }
        ],
        response_format: { type: "json_object" }
    });

    return response;
}

async function analyzeSentiment(text) {
    const response = await openai.chat.completions.create({
        model: OPENAI_SETTINGS.model,
        messages: [
            {
                role: "system",
                content: OPENAI_PROMPTS.sentiment.content
            },
            {
                role: "user",
                content: text
            }
        ],
        response_format: { type: "json_object" }
    });

    return response;
}