\n{"test": "value"}\n```';
assert.strictEqual(
    cleanMarkdownFormatting(basicMarkdown),
    '{"test": "value"}',
    'Failed to clean basic markdown'
);

// Test with language identifier
const jsonMarkdown = '```json\n{"test": "value"}\n```';
assert.strictEqual(
    cleanMarkdownFormatting(jsonMarkdown),
    '{"test": "value"}',
    'Failed to clean markdown with json identifier'
);

// Test with different language identifier
const javascriptMarkdown = '```javascript\n{"test": "value"}\n```';
assert.strictEqual(
    cleanMarkdownFormatting(javascriptMarkdown),
    '{"test": "value"}',
    'Failed to clean markdown with language identifier'
);

// Test with no markdown
const noMarkdown = '{"test": "value"}';
assert.strictEqual(
    cleanMarkdownFormatting(noMarkdown),
    '{"test": "value"}',
    'Should not modify string without markdown'
);

// Test error handling
try {
    cleanMarkdownFormatting(null);
    assert.fail('Should have thrown error for null input');
} catch (error) {
    assert.strictEqual(
        error.message,
        'Input must be a string',
        'Wrong error message for null input'
    );
}

// Test Suite: parseJsonResponse
console.log('\nTesting parseJsonResponse...');

// Test parsing valid JSON with markdown
const validMarkdownJson = '```json\n{"test": "value", "nested": {"key": 42}}\n```';
const expectedObj = { test: 'value', nested: { key: 42 } };
assert.deepStrictEqual(
    parseJsonResponse(validMarkdownJson),
    expectedObj,
    'Failed to parse valid JSON with markdown'
);

// Test parsing clean JSON without markdown
const cleanJson = '{"direct": "test"}';
assert.deepStrictEqual(
    parseJsonResponse(cleanJson),
    { direct: 'test' },
    'Failed to parse clean JSON'
);

// Test parsing invalid JSON
try {
    parseJsonResponse('```json\n{"invalid": "json",}\n