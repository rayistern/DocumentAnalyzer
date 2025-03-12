/**
 * Global Timeout Configuration
 * 
 * This file centralizes all timeout settings to prevent runaway processes.
 * See docs/timeout-system.md for complete documentation.
 */
import readline from 'readline';

// Global default timeout in hours - applies to all processes unless overridden
export const GLOBAL_TIMEOUT_HOURS = 24;

/**
 * File-specific timeout overrides
 * These settings override the global default for specific files
 */
export const FILE_OVERRIDES = {
    // Format: 'filename.mjs': hours
    // Examples:
    // 'index.mjs': 15,           // 15 hours timeout for index.mjs
    // 'dbService.mjs': 8,        // 8 hours timeout for dbService.mjs
    // 'process_monitor.mjs': 24  // 24 hours timeout for process_monitor.mjs
};

/**
 * Process-type specific timeout overrides
 * These settings override both global and file-specific settings
 * Specifically for batch processing commands run through index.mjs
 */
export const PROCESS_OVERRIDES = {
    // For batch processing specific types
    'fullMetadata_only': 5,    // 20 hours for fullMetadata processing (which takes longer)
    //'cleanAndChunk': 12,        // 12 hours for cleanAndChunk processing
    
    // Can also set overrides for other command types
    // 'process-metadata': 18,   // Example: 18 hours for metadata processing command
};

/**
 * Creates a readline interface for user input
 * @returns {readline.Interface} A readline interface
 */
function createReadlineInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
}

/**
 * Sets up an automatic timeout to pause the process after a specified duration
 * and prompts the user to continue or exit
 * 
 * @param {number} hours - Default timeout in hours (defaults to GLOBAL_TIMEOUT_HOURS)
 * @param {string} processType - Optional process type for command-specific overrides
 * @returns {void}
 */
export function setupProcessTimeout(hours = GLOBAL_TIMEOUT_HOURS, processType = null) {
    // 1. Start with the global default
    let finalHours = hours;
    let overrideSource = null;
    
    // 2. Check for file-specific override
    const currentFile = getCurrentFileName();
    if (currentFile && FILE_OVERRIDES[currentFile]) {
        finalHours = FILE_OVERRIDES[currentFile];
        overrideSource = `file: ${currentFile}`;
    }
    
    // 3. Process-type override takes highest precedence
    if (processType && PROCESS_OVERRIDES[processType]) {
        finalHours = PROCESS_OVERRIDES[processType];
        overrideSource = `process-type: ${processType}`;
    }
    
    // Convert to milliseconds and set the timeout
    const timeoutMs = finalHours * 60 * 60 * 1000;
    console.log(`\n[${new Date().toISOString()}] ⏱️ Setting up automatic timeout after ${finalHours} hours${overrideSource ? ` (using override from ${overrideSource})` : ''}`);
    
    setTimeout(() => {
        console.log(`\n[${new Date().toISOString()}] ⏱️ TIMEOUT REACHED after ${finalHours} hours`);
        console.log(`[${new Date().toISOString()}] Process has been running for a long time and will be paused.`);
        
        const rl = createReadlineInterface();
        
        // Prompt user to continue or exit
        rl.question('Press "y" to continue processing, or any other key to exit: ', (answer) => {
            rl.close();
            
            if (answer.toLowerCase() === 'y') {
                console.log(`\n[${new Date().toISOString()}] ✅ Process continuing by user request`);
                // Reset the timeout for another period
                setupProcessTimeout(finalHours, processType);
            } else {
                console.log(`\n[${new Date().toISOString()}] ❌ Process terminated by user request`);
                process.exit(0);
            }
        });
    }, timeoutMs);
}

/**
 * Helper function to get the current file name from the stack trace
 * 
 * @returns {string|null} The current file name or null if not detectable
 * @private
 */
function getCurrentFileName() {
    try {
        // Get the current module's filename from the stack trace
        const stackTrace = new Error().stack;
        const callerLine = stackTrace.split('\n')[2]; // The caller will be the third line in the stack trace
        
        // Extract the filename from the stack trace
        const match = callerLine.match(/[\/\\]([\w\-\.]+\.m?js)/);
        return match ? match[1] : null;
    } catch (error) {
        console.error(`Error detecting current filename: ${error.message}`);
        return null;
    }
} 