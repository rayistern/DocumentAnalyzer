# Timeout System Documentation

## Overview

The DocumentAnalyzer includes an automatic timeout system to pause long-running processes. This system will automatically pause any process after a specified duration and provide multiple ways for the user to continue or exit, ensuring that no process runs indefinitely due to unexpected errors or issues.

## Important: How Pausing Works

- **The process is NOT terminated** when a timeout occurs - it's simply paused while waiting for your decision
- **All data stays in memory** - all variables, objects, and state remain intact during the pause
- **The continue.txt file works as a signal** - the running process is actively checking for this file every 10 seconds
- **You can continue from where you left off** - whether it's 5 minutes or 5 days later, the process will resume exactly where it paused

## How It Works

1. **Global Default:** By default, all processes will automatically pause after 24 hours.
2. **Per-File Overrides:** You can specify different timeout durations for specific files.
3. **Process-Type Overrides:** You can set different timeouts for specific processing types.
4. **User Interaction:** When a timeout is reached, the process pauses and provides two ways to continue:
   - Creating a "continue.txt" file with content "y"
   - Interactive terminal input (if terminal is interactive)

## Configuration

All timeout settings are centralized in `src/config.mjs`. To modify timeouts:

### Changing the Global Default

```javascript
// In config.mjs
export const GLOBAL_TIMEOUT_HOURS = 24; // Change this value to modify the default timeout
```

### Setting Per-File Overrides

```javascript
// In config.mjs
export const FILE_OVERRIDES = {
    'index.mjs': 15,           // 15 hours timeout for index.mjs
    'dbService.mjs': 8,        // 8 hours timeout for dbService.mjs
    'process_monitor.mjs': 24  // 24 hours timeout for process_monitor.mjs
};
```

### Setting Process-Type Overrides

```javascript
// In config.mjs
export const PROCESS_OVERRIDES = {
    // For batch processing with different processing types
    'fullMetadata_only': 5,    // 5 hours for fullMetadata processing
    'cleanAndChunk': 12,       // 12 hours for cleanAndChunk processing
    
    // For other command types
    'process-metadata': 18,     // 18 hours for metadata processing command
};
```

## Override Precedence

The system uses the following precedence for determining the timeout:

1. Process-type override (highest precedence)
2. File-specific override
3. Global default (lowest precedence)

## Usage Examples

### Basic Usage

Every file should include and call the setupProcessTimeout function:

```javascript
import { setupProcessTimeout } from './config.mjs';

// Set up the global timeout for all processes
setupProcessTimeout();
```

### Command-Specific Usage

For commands that need process-specific timeouts:

```javascript
// In index.mjs for batch command
setupProcessTimeout(undefined, options.type); // Pass the process type
```

## Common Process Types

- `fullMetadata_only` - Full metadata processing (takes longer)
- `cleanAndChunk` - Basic document cleaning and chunking
- `process-metadata` - Metadata processing command

## User Interaction: Step-by-Step

When a timeout is reached:

1. The process pauses (but remains running in memory - it is NOT terminated)
2. You'll see a message like:
   ```
   [2023-07-20T15:30:00.000Z] ⏱️ PROCESS PAUSED due to timeout
   [2023-07-20T15:30:00.000Z] To continue, create a file named "continue.txt" in the current directory with the content "y"
   [2023-07-20T15:30:00.000Z] Current directory: C:\Scripts\git\chunking\copy-of-documentAnalyzer
   ```

3. To continue processing, you have two options:

   **Option 1: Create a continue file** (works even if your SSH session disconnected or you're connecting from a different computer)
   ```bash
   # Using PowerShell
   echo "y" > continue.txt
   
   # Using Command Prompt
   echo y > continue.txt
   
   # Using Bash (Linux/Mac)
   echo "y" > continue.txt
   ```
   
   The file must:
   - Be named exactly "continue.txt"
   - Be created in the directory shown in the message
   - Contain the letter "y" (lowercase or uppercase)
   
   **Option 2: Interactive input** (only if your terminal is still connected and interactive)
   - Just type "y" and press Enter when prompted

4. The process will:
   - Detect your continue signal (checking every 10 seconds for the file)
   - Automatically delete the continue.txt file after reading it
   - Resume execution from exactly where it left off
   - Reset the timeout for another period

### Example Scenario

1. You start a batch process that will take 30 hours to complete
2. After 5 hours (the timeout for fullMetadata_only), the process pauses
3. You're not at your computer, so it stays paused (all data remains in memory)
4. You return 2 days later and create the continue.txt file
5. The process sees the file, deletes it, and continues for another 5 hours
6. This repeats until the process completes (or until you choose not to continue)

## Logs

When a timeout is activated, you'll see:
```
[2023-01-01T00:00:00.000Z] ⏱️ Setting up automatic timeout after 5 hours (using override from process-type: fullMetadata_only)
```

When a timeout is reached:
```
[2023-01-01T05:00:00.000Z] ⏱️ PROCESS PAUSED due to timeout
[2023-01-01T05:00:00.000Z] To continue, create a file named "continue.txt" in the current directory with the content "y"
[2023-01-01T05:00:00.000Z] Current directory: /path/to/working/directory
[2023-01-01T05:00:00.000Z] If terminal is interactive, you can also type "y" and press Enter to continue:
Press "y" to continue processing, or any other key to exit:
```

If user continues (via file):
```
[2023-01-01T05:05:00.000Z] ✅ Continue file detected! Resuming process...
```

If user continues (via readline):
```
[2023-01-01T05:05:00.000Z] ✅ Process continuing by user request
```

If user exits:
```
[2023-01-01T05:05:00.000Z] ❌ Process terminated by user request
```

## Technical Implementation Details

- The system uses JavaScript's `setTimeout()` to schedule the timeout.
- The process is NOT terminated when a timeout occurs - it keeps running but pauses execution until instructed to continue.
- For file-based continuation, the system uses `setInterval()` to check for the continue.txt file every 10 seconds.
- The file is automatically deleted after being read - you don't need to delete it yourself.
- Interactive input is handled through the Node.js readline interface.
- The timeout is reset for another period if the user chooses to continue.
- If the user chooses to exit, the process is terminated gracefully with `process.exit(0)`.
- The system is designed to be robust in both interactive and non-interactive environments.