export const OPENAI_SETTINGS = {
    model: "o3-mini",  // default model
    defaultMaxChunkLength: 3000,
    textRemovalPositionTolerance: 35,  // Maximum character difference allowed for text removal positions
    preChunkSize: 11000,  // Size for pre-chunking before LLM processing
    fallbackModels: ["o1-mini", "gpt-4o-mini", "o3-mini"],  // In order of preference
    retryConfig: {
        maxRetries: 3,
        retryDelayMs: 1000
    },
    gapConfig: {
        maxTolerance: 1
    },
    modelConfig: {
        // Models that support JSON response format
        jsonFormatSupported: ['gpt-4o', 'gpt-4o-mini'],
        // Models to use for different operations
        operations: {
            clean: "gpt-4o-mini",
            chunk: "gpt-4o-mini",
            metadata: "gpt-4o-mini",
            summarize: "gpt-4o-mini",
            sentiment: "gpt-4o-mini",
            fullMetadata: "o1"
        }
    }
};

export const OPENAI_PROMPTS = {
    cleanAndChunk: {
        clean: (isIncomplete = false) => ({
            role: "user",
            content: `Identify any text that should be removed from this document${isIncomplete ? ' (note: this text may be cut off at the end, please ignore any incomplete text)' : ''}, such as:
                - Page numbers and headers (e.g., "Page 1", "Chapter 1:")
                - Divider lines (e.g., "----------")
                - Headers and footers
                - Footnotes, citations, and references
                - Footnote numbers or reference markers within the body of the text (along with their punctuation)
                - Version numbers or draft markings
                - Any other non-content structural elements

                For each piece of text to remove, provide:
                1. The exact text to remove
                2. Its start and end positions
                3. 10 characters of context before and after (if available)

                Return a valid JSON in the following exact format (no preface):
                {
                    "textToRemove": [
                        {
                            "text": "Page 1",
                            "startPosition": 1,
                            "endPosition": 6,
                            "contextBefore": "text before",
                            "contextAfter": "text after"
                        }
                    ]
                }`
        }),
        fullMetadata: (overview = '', ) => ({
            role: "user",
            content: `${overview ? overview + '\n\n' : ''}Provide metadata (in English) in the following JSON format (with no preface):
{
    "longDescription": "1-2 paragraphs describing the main content and arguments",
    "keywords": ["array", "of", "key", "topics", "and", "themes"], -- specific keywords on this specific piece of text or letter, not generic like "chabad" or "jewish"
    "questionsAnswered": ["Question?", "Answer"] -- One Q&A pair: An implied question which the text addresses. This Q&A pair will be used for future training. Please output a thorough, long form answer, the way an LLM should respond conversationally. Include only information that is stated in the text, and only that information which answers the question.
}`
        }),
        chunk: (maxChunkLength, isIncomplete = false) => ({
            role: "user",
            content: `Segment this text into self-contained sections based on topic shifts. Each chunk should fully capture a concept but remain under ${maxChunkLength} characters - and the longer the better.
            ${isIncomplete ? ' (note: this text may be cut off at the end, please ignore any incomplete text)' : ''}
                - Record the exact first and last complete words of each chunk for validation
                - Each subsequent chunk MUST start right after the previous chunk's ending punctuation
                - There MUST NOT be any gaps or overlaps between chunks
                - Include all punctuation in the chunks
                - If the entire text is one single theme, return a single chunk
                - Remember that this is Hebrew text, so some characters operate differently than in English and may not indicate the end of a sentence

                Return a valid JSON in the following exact format (no preface):
                {
                    "chunks": [
                        {
                            "startIndex": 1,
                            "endIndex": 23,
                            "firstWord": "The",
                            "lastWord": "mat.",
                        }
                    ]
                }`
        })
    },
    summarize: {
        role: "user",
        content: "Summarize the following text and provide the result in JSON format with 'summary' and 'keyPoints' fields."
    },
    sentiment: {
        role: "user",
        content: "Analyze the sentiment of the text and provide a JSON response with 'sentiment' (positive/negative/neutral), 'score' (1-5), and 'confidence' (0-1) fields."
    },
    metadata: () => ({
        role: "user",
        content: `Analyze the given text chunk and provide detailed metadata in JSON format. Each piece of metadata needs to be standalone, not using ambiguous references like 'the text'. Include:
    - long_summary (1-2 paragraphs, in English. The audience is familiar with the domain.)
    - short_summary (1-2 sentences, in English)
    - quiz_questions (3-5 questions in English. Make sure these can be used standalone and do not ambiguously reference the text.)
    - followup_thinking_questions (2-3 deeper analytical questions, in English)
    - generated_title (in English)
    - tags_he (Hebrew, keywords)
    - key_terms_he (domain specific terms/phrases, in the original Hebrew)
    - key_phrases_he (important Hebrew quotes)
    - key_phrases_en (English translations of key phrases)
    - bibliography_snippets (array of explicit citations {snippet, source}, Original Hebrew)
    - questions_explicit (directly stated in text, Original Hebrew)
    - questions_implied (suggested by the content, English)
    - reconciled_issues (how the text resolves contradictions, English)
    - qa_pair (One Q&A pair: implied question which the text answers, not a question about the text. This will be used for future training. Please output a thorough, specific, long form answer, the way an LLM should respond conversationally. Include only information that is explicitly stated in the text, and only that information which answers the question.)
    - potential_typos (array of possible errors, Original Hebrew)
    - identified_abbreviations (array of abbreviations with expansions, Original Hebrew)
    - named_entities (array of people, places, texts mentioned, Original Hebrew)

Return valid JSON only, no markdown.`
    })
};