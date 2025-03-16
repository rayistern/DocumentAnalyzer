/**
 * Global Timeout Configuration
 * 
 * This file centralizes all timeout settings to prevent runaway processes.
 * See docs/timeout-system.md for complete documentation.
 */
import readline from 'readline';
import fs from 'fs';
import path from 'path';

// Global default timeout in hours - applies to all processes unless overridden
export const GLOBAL_TIMEOUT_HOURS = 7;

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
    'fullMetadata_only': 5,    // 5 hours for fullMetadata processing
    //'cleanAndChunk': 12,        // 12 hours for cleanAndChunk processing
    
    // Can also set overrides for other command types
    // 'process-metadata': 18,   // Example: 18 hours for metadata processing command
};

// Flag to track if process is paused
let isPaused = false;
// Track timeouts to clear them if needed
let activeTimeout = null;

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
 * Checks if the user has created a continue file to resume processing
 * @returns {boolean} True if continue file exists, false otherwise
 */
function checkContinueFile() {
    try {
        const continueFilePath = path.join(process.cwd(), 'continue.txt');
        if (fs.existsSync(continueFilePath)) {
            // Read the file to see if it contains 'y'
            const content = fs.readFileSync(continueFilePath, 'utf8').trim().toLowerCase();
            const shouldContinue = content === 'y';
            
            // Delete the file after reading
            fs.unlinkSync(continueFilePath);
            
            return shouldContinue;
        }
        return false;
    } catch (error) {
        console.error(`Error checking continue file: ${error.message}`);
        return false;
    }
}

/**
 * Check for continue file periodically
 * @param {number} hours - Timeout hours to pass to restart function
 * @param {string} processType - Process type to pass to restart function
 */
function startContinueFileCheck(hours, processType) {
    console.log(`\n[${new Date().toISOString()}] ⏱️ PROCESS PAUSED due to timeout`);
    console.log(`[${new Date().toISOString()}] To continue, create a file named "continue.txt" in the current directory with the content "y"`);
    console.log(`Current directory: ${process.cwd()}`);
    
    isPaused = true;
    
    // Check every 10 seconds if the continue file exists
    const checkInterval = setInterval(() => {
        if (checkContinueFile()) {
            console.log(`\n[${new Date().toISOString()}] ✅ Continue file detected! Resuming process...`);
            clearInterval(checkInterval);
            isPaused = false;
            
            // Restart the timeout
            setupProcessTimeout(hours, processType);
        }
    }, 10000); // Check every 10 seconds
    
    // Also set up the readline interface as a backup
    tryReadlinePrompt(checkInterval, hours, processType);
}

/**
 * Try to use readline interface as a backup method
 * @param {NodeJS.Timeout} checkInterval - Interval to clear if readline succeeds
 * @param {number} hours - Hours to pass to restart function
 * @param {string} processType - Process type to pass to restart function
 */
function tryReadlinePrompt(checkInterval, hours, processType) {
    try {
        const rl = createReadlineInterface();
        
        console.log(`\n[${new Date().toISOString()}] If terminal is interactive, you can also type "y" and press Enter to continue:`);
        
        rl.question('Press "y" to continue processing, or any other key to exit: ', (answer) => {
            rl.close();
            
            if (answer.toLowerCase() === 'y') {
                console.log(`\n[${new Date().toISOString()}] ✅ Process continuing by user request`);
                clearInterval(checkInterval);
                isPaused = false;
                
                // Reset the timeout for another period
                setupProcessTimeout(hours, processType);
            } else {
                console.log(`\n[${new Date().toISOString()}] ❌ Process terminated by user request`);
                clearInterval(checkInterval);
                process.exit(0);
            }
        });
    } catch (error) {
        console.error(`Error setting up readline: ${error.message}`);
        // Continue with just the file check if readline fails
    }
}

/**
 * Sets up an automatic timeout to pause the process after a specified duration
 * and provides multiple ways for the user to continue or exit
 * 
 * @param {number} hours - Default timeout in hours (defaults to GLOBAL_TIMEOUT_HOURS)
 * @param {string} processType - Optional process type for command-specific overrides
 * @returns {void}
 */
export function setupProcessTimeout(hours = GLOBAL_TIMEOUT_HOURS, processType = null) {
    // Don't set a new timeout if the process is paused
    if (isPaused) return;
    
    // Clear any existing timeout
    if (activeTimeout) {
        clearTimeout(activeTimeout);
    }
    
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
    
    // Set the timeout
    activeTimeout = setTimeout(() => {
        startContinueFileCheck(finalHours, processType);
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