import { OPENAI_SETTINGS } from '../config/settings.mjs';
import { logLLMResponse } from './llmLoggingService.mjs';

export async function retryWithFallback(operation, modelIndex = 0) {
    const { fallbackModels, retryConfig } = OPENAI_SETTINGS;
    let lastError;
    
    const model = fallbackModels[modelIndex];
    console.log(`\n=== Starting operation with model: ${model} ===`);
    
    for (let retry = 0; retry < retryConfig.maxRetries; retry++) {
        try {
            const result = await operation(model);
            console.log(`Operation succeeded with model: ${model}`);
            return result;
        } catch (error) {
            lastError = error;
            console.error(`Attempt ${retry + 1} failed with model ${model}:`, error.message);
            try {
                await logLLMResponse(null, `Error: ${error.message}`, model);
            } catch (logError) {
                console.error('Failed to log error:', logError.message);
            }
            
            if (modelIndex < fallbackModels.length - 1) {
                const nextModel = fallbackModels[modelIndex + 1];
                console.log(`\n=== Falling back to model ${nextModel} (${modelIndex + 2}/${fallbackModels.length}) ===`);
                return retryWithFallback(operation, modelIndex + 1);
            }
            
            console.log(`Waiting ${retryConfig.retryDelayMs}ms before retry ${retry + 2}/${retryConfig.maxRetries}...`);
            await new Promise(resolve => setTimeout(resolve, retryConfig.retryDelayMs));
        }
    }
    
    console.error('All retries and fallbacks exhausted');
    throw lastError;
}

export function validateGap(gapText) {
    if (gapText.length > OPENAI_SETTINGS.gapConfig.maxTolerance) {
        return {
            isError: true,
            message: `Error: Gap of ${gapText.length} characters exceeds maximum tolerance of ${OPENAI_SETTINGS.gapConfig.maxTolerance}. Gap content: "${gapText}"`
        };
    }
    return {
        isError: false,
        message: `Warning: Small gap detected (${gapText.length} chars). Gap content: "${gapText}"`
    };
}
