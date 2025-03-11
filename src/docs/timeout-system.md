# Timeout System Documentation

## Overview

The DocumentAnalyzer includes an automatic timeout system to prevent runaway processes. This system will automatically terminate any process after a specified duration, ensuring that no process runs indefinitely due to unexpected errors or issues.

## How It Works

1. **Global Default:** By default, all processes will automatically terminate after 10 hours.
2. **Per-File Overrides:** You can specify different timeout durations for specific files.
3. **Process-Type Overrides:** You can set different timeouts for specific processing types.

## Configuration

All timeout settings are centralized in `src/config.mjs`. To modify timeouts:

### Changing the Global Default

```javascript
// In config.mjs
export const GLOBAL_TIMEOUT_HOURS = 10; // Change this value to modify the default timeout
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

## Logs

When a timeout is activated, you'll see:
```
[2023-01-01T00:00:00.000Z] ⏱️ Setting up automatic timeout after 20 hours (using override from process-type: fullMetadata_only)
```

When a timeout occurs:
```
[2023-01-01T10:00:00.000Z] ⏱️ AUTOMATIC TIMEOUT TRIGGERED after 20 hours
[2023-01-01T10:00:00.000Z] Process is being terminated to prevent runaway execution
```

## Implementation Details

- The system uses JavaScript's `setTimeout()` to schedule the termination.
- File detection uses stack trace analysis to identify which file is setting up the timeout.
- When a timeout occurs, the process exits gracefully with `process.exit(0)`.
- Process-type detection is handled by passing the process type as a parameter to the `setupProcessTimeout` function.