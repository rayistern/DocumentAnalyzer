import OpenAI from 'openai';
import { db } from '../db.js';
import { llmResponses } from '../schema.js';

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export async function processFile(content, type) {
    const startTime = Date.now();
    try {
        let response;
        if (type === 'sentiment') {
            response = await analyzeSentiment(content);
        } else {
            response = await summarizeContent(content);
        }

        // Log the LLM response
        await db.insert(llmResponses).values({
            model: "gpt-4o",
            prompt: content,
            response: response,
            processingTime: Date.now() - startTime,
            type: type
        });

        return response;
    } catch (error) {
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

        return JSON.parse(response.choices[0].message.content);
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

        return JSON.parse(response.choices[0].message.content);
    } catch (error) {
        throw new Error(`Sentiment analysis failed: ${error.message}`);
    }
}