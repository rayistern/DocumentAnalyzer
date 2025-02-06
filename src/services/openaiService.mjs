\n|\n```/g, ''));
        } catch (error) {
            console.warn('Failed to parse JSON response, returning raw content');
            return { summary: content };
        }
    } catch (error) {
        await logLLMResponse(null, error.message, 'error');
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
            ...(OPENAI_SETTINGS.model !== 'o1-preview' && {
                response_format: { type: "json_object" }
            })
        });

        // Log raw response first
        await logLLMResponse(null, response);

        // Try to parse JSON response
        const content = response.choices[0].message.content;
        try {
            return JSON.parse(content.replace(/```json\n|\n```/g, ''));
        } catch (error) {
            console.warn('Failed to parse JSON response, returning raw content');
            return { sentiment: content };
        }
    } catch (error) {
        await logLLMResponse(null, error.message, 'error');
        throw new Error(`Sentiment analysis failed: ${error.message}`);
    }
}

async function createChunks(text, maxChunkLength) {
    try {
        const response = await openai.chat.completions.create({
            model: OPENAI_SETTINGS.model,
            messages: [
                {
                    role: OPENAI_PROMPTS.chunk.role,
                    content: OPENAI_PROMPTS.chunk.content(maxChunkLength)
                },
                {
                    role: "user",
                    content: text
                }
            ],
            ...(OPENAI_SETTINGS.model !== 'o1-preview' && {
                response_format: { type: "json_object" }
            })
        });

        // Log raw response first
        await logLLMResponse(null, response);

        // Try to parse JSON response
        const content = response.choices[0].message.content;
        try {
            const result = JSON.parse(content.replace(/```json\n|\n