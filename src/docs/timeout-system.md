# Timeout System Documentation

## Overview

The DocumentAnalyzer includes an automatic timeout system to pause long-running processes. This system will automatically pause any process after a specified duration and prompt the user to continue or exit, ensuring that no process runs indefinitely due to unexpected errors or issues.

## How It Works

1. **Global Default:** By default, all processes will automatically pause after 24 hours.
2. **Per-File Overrides:** You can specify different timeout durations for specific files.
3. **Process-Type Overrides:** You can set different timeouts for specific processing types.
4. **User Interaction:** When a timeout is reached, the process pauses and prompts the user to continue or exit.

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
    'fullMetadata_only': 20,    // 20 hours for fullMetadata processing
    'cleanAndChunk': 12,        // 12 hours for cleanAndChunk processing
    
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

## User Interaction

When a timeout is reached, the system will:

1. Pause the process
2. Display a prompt asking the user to continue or exit
3. Wait for user input:
   - If the user presses 'y', the process will continue and the timeout will be reset
   - If the user presses any other key, the process will terminate gracefully

## Logs

When a timeout is activated, you'll see:
```
[2023-01-01T00:00:00.000Z] ⏱️ Setting up automatic timeout after 20 hours (using override from process-type: fullMetadata_only)
```

When a timeout is reached:
```
[2023-01-01T10:00:00.000Z] ⏱️ TIMEOUT REACHED after 20 hours
[2023-01-01T10:00:00.000Z] Process has been running for a long time and will be paused.
Press "y" to continue processing, or any other key to exit:
```

If user continues:
```
[2023-01-01T10:00:05.000Z] ✅ Process continuing by user request
```

If user exits:
```
[2023-01-01T10:00:05.000Z] ❌ Process terminated by user request
```

## Implementation Details

- The system uses JavaScript's `setTimeout()` to schedule the timeout.
- File detection uses stack trace analysis to identify which file is setting up the timeout.
- User interaction is handled through the Node.js readline interface.
- The timeout is reset for another period if the user chooses to continue.
- When a user chooses to exit, the process exits gracefully with `process.exit(0)`.