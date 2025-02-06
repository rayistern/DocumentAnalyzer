import OpenAI from 'openai';
import { OPENAI_PROMPTS } from '../config/prompts.mjs';
import { OPENAI_SETTINGS } from '../config/settings.mjs';

// the newest OpenAI model is "gpt-4o" which was released May 13, 2024. do not change this unless explicitly requested by the user
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export async function processFile(content, type, maxChunkLength = OPENAI_SETTINGS.defaultMaxChunkLength) {
    try {
        if (type === 'sentiment') {
            return await analyzeSentiment(content);
        } else if (type === 'chunk') {
            return await chunkContent(content, parseInt(maxChunkLength));
        } else {
            return await summarizeContent(content);
        }
    } catch (error) {
        throw new Error(`OpenAI processing failed: ${error.message}`);
    }
}

async function summarizeContent(text) {
    try {
        const response = await openai.chat.completions.create({
            model: OPENAI_SETTINGS.model,
            messages: [
                OPENAI_PROMPTS.summarize,
                {
                    role: "user",
                    content: text
                }
            ],
            response_format: { type: "json_object" }
        });

        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        throw new Error(`Summarization failed: ${error.message}`);
    }
}

async function analyzeSentiment(text) {
    try {
        const response = await openai.chat.completions.create({
            model: OPENAI_SETTINGS.model,
            messages: [
                OPENAI_PROMPTS.sentiment,
                {
                    role: "user",
                    content: text
                }
            ],
            response_format: { type: "json_object" }
        });

        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        throw new Error(`Sentiment analysis failed: ${error.message}`);
    }
}

async function chunkContent(text, maxChunkLength = OPENAI_SETTINGS.defaultMaxChunkLength) {
    try {
        const response = await openai.chat.completions.create({
            model: OPENAI_SETTINGS.model,
            messages: [
                {
                    ...OPENAI_PROMPTS.chunk,
                    content: OPENAI_PROMPTS.chunk.content(maxChunkLength)
                },
                {
                    role: "user",
                    content: text
                }
            ],
            response_format: { type: "json_object" }
        });

        const result = JSON.parse(response.choices[0].message.content);
        return result;
    } catch (error) {
        throw new Error(`Chunking failed: ${error.message}`);
    }
}