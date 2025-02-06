import OpenAI from 'openai';
import { db } from '../db.mjs';
import { llmResponses } from '../schema.mjs';
import { openAILogger as logger } from './loggingService.mjs';
import { OPENAI_SETTINGS } from '../config/settings.mjs';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export async function processFile(content, type) {
    const startTime = Date.now();
    try {
        const messages = [
            {
                role: "system",
                content: type === 'sentiment' ? 
                    "Analyze the sentiment of the text." :
                    "Summarize the following text."
            },
            {
                role: "user",
                content: content
            }
        ];

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages
        });

        // Store raw LLM response in database
        await db.insert(llmResponses).values({
            model: "gpt-4o",
            prompt: content,
            response: response.choices[0].message,
            processingTime: Date.now() - startTime,
            type: type
        });

        return response.choices[0].message;
    } catch (error) {
        throw new Error(`OpenAI processing failed: ${error.message}`);
    }
}