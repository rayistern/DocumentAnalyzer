')) {
        return trimmed
            .replace(/^```json\s*/m, '')  // Remove ```json prefix with any whitespace
            .replace(/^```\s*/m, '')      // Remove ``` prefix with any whitespace
            .replace(/\s*```\s*$/m, '')   // Remove trailing