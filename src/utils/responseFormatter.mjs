')) {
        // Find the first newline
        const firstNewline = cleaned.indexOf('\n');
        if (firstNewline !== -1) {
            // Remove the opening ``` and any language identifier
            cleaned = cleaned.substring(firstNewline + 1);
        }
    }

    // Remove the closing code block if present
    if (cleaned.endsWith('