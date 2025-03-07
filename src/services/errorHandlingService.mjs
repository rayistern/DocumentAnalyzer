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

// Global timeout setting in hours
const GLOBAL_TIMEOUT_HOURS = 10;

// Add automatic timeout function
function setupProcessTimeout(hours = GLOBAL_TIMEOUT_HOURS) {
    const timeoutMs = hours * 60 * 60 * 1000; // Convert hours to milliseconds
    console.log(`\n[${new Date().toISOString()}] ⏱️ Setting up automatic timeout after ${hours} hours`);
    
    setTimeout(() => {
        console.log(`\n[${new Date().toISOString()}] ⏱️ AUTOMATIC TIMEOUT TRIGGERED after ${hours} hours`);
        console.log(`[${new Date().toISOString()}] Process is being terminated to prevent runaway execution`);
        process.exit(0);
    }, timeoutMs);
}

// Set up the global timeout for all processes
setupProcessTimeout();

            
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
