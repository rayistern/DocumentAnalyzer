import { OPENAI_SETTINGS } from '../config/settings.mjs';

export async function retryWithFallback(operation, modelIndex = 0) {
    const { fallbackModels, retryConfig } = OPENAI_SETTINGS;
    let lastError;
    
    for (let retry = 0; retry < retryConfig.maxRetries; retry++) {
        try {
            const result = await operation(fallbackModels[modelIndex]);
            return result;
        } catch (error) {
            lastError = error;
            console.error(`Attempt ${retry + 1} failed with model ${fallbackModels[modelIndex]}:`, error);
            await logLLMResponse(null, `Error: ${error.message}`, fallbackModels[modelIndex]);
            
            if (modelIndex < fallbackModels.length - 1) {
                console.log(`Falling back to model ${fallbackModels[modelIndex + 1]}`);
                return retryWithFallback(operation, modelIndex + 1);
            }
            
            await new Promise(resolve => setTimeout(resolve, retryConfig.retryDelayMs));
        }
    }
    
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
