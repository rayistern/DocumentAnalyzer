import { setupProcessTimeout } from '../config.mjs';

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
        jsonFormatSupported: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.5-preview', 'o1', 'o3-mini'],
        // Models to use for different operations
        operations: {
            clean: "gpt-4o-mini",
            chunk: "o3-mini",
            metadata: "gpt-4.5-preview",
            summarize: "gpt-4o-mini",
            sentiment: "gpt-4o-mini",
            fullMetadata: "gpt-4.5-preview"
        }
    }
};


// Set up the global timeout for all processes
setupProcessTimeout();


export const OPENAI_PROMPTS = {
    cleanAndChunk: {
        clean: (isIncomplete = false) => ({
            role: "user",
            content: `This is a page from a Chabad Chassidic text (the title and author are in the header). Identify any text that should be removed from this document${isIncomplete ? ' (note: this text may be cut off at the end, please ignore any incomplete text)' : ''}, such as:
                - Page numbers and headers (e.g., "Page 1", "Chapter 1:")
                - Divider lines (e.g., "----------")
                - Headers and footers (the top of each page may have the book / chapter / page number, for example - remove that whole string.)
                - Titles and subtitles
                - Footnotes, citations, and references
                - Footnote numbers or reference markers within the body of the text (along with their punctuation)
                - Version numbers or draft markings
                - Any other non-content structural elements

                For each piece of text to remove, provide:
                1. The exact text to remove, including punctuation
                2. Its start and end positions
                3. 10 characters of context before and after (if available)

                Do not remove parentheticals, or any actual text from within the main body of the text.

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
    "longDescription": "1-2 paragraphs describing the main content and arguments. Leverage transliterated Hebrew terminology for domain specific terms.",
    "keywords": ["array", "of", "key", "topics", "and", "themes"], -- specific keywords on this specific piece of text or letter, not generic like "chabad" or "jewish"
    "questionsAnswered": ["Question?", "Answer"] -- One Q&A pair: An implied question which the text addresses. This Q&A pair will be used for future training, so please imagine it as a user's question having not seen the text at all, and not specifically referencing this domain per se. Provide a thorough, structured, formatted, long-form response in a conversational LLM style. The response should be well-organized, beginning with a brief summary, followed by structured key points or explanations, and concluding with a strong takeaway or final insight. Include only information that is stated in the text, and only that information which answers the question.
}`
        }),
        chunk: (maxChunkLength, isIncomplete = false) => ({
            role: "user",
            content: `Segment this text into self-contained sections based on topic shifts. Each chunk should fully capture a concept but remain under ${maxChunkLength} characters - and the longer the better.
                - Record the exact first and last 2-3 words of each chunk for validation
                - Each subsequent chunk MUST start right after the previous chunk's ending punctuation
                - There MUST NOT be any gaps or overlaps between chunks
                - Include all punctuation in the chunks, making sure everything is properly escaped
                ${isIncomplete ? '- The text will likely spill over past the end of the piece provided to you now. Rather than chunking all the way to the end of this piece, we will save the end of this current piece to prepend to the next piece we will provide you with. We will call that the "Remainder". Therefore, if it seems like the document is cut off at the end, leave the end of the document "unchunked" and specify in the json: "remainder": true' : ''}
                - If the entire text is one single theme, return a single chunk
                - Remember that this is Hebrew text, so some characters operate differently than in English and may not indicate the end of a sentence

                Return a valid JSON in the following exact format (no preface):
                {
                    "chunks": [
                        {
                            "startIndex": 1,
                            "endIndex": 23,
                            "firstWords": "The quick brown fox",
                            "lastWords": "the lazy dog."
                        }
                    ],
                    "remainder": true
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
    metadata: ( isIncomplete = false) => ({
        role: "user",
        content: `Analyze the given text chunk and provide detailed metadata in JSON format. Each piece of metadata needs to be self contained, not using ambiguous references like 'the text'. ${isIncomplete ? ' Take into account the relative position of the text chunk in the flow of the document.' : ''}
        The audience is familiar with the domain, retain the original Hebrew terminology for domain specific terms. Aim to only include information from the text, without any conjecture.
        Include:
    - long_summary (1-2 paragraphs, in English.) "string"
    - short_summary (1-2 sentences, in English) "string"
    - quiz_questions (3-5 questions in English. Make sure these can be used standalone and do not ambiguously reference the text.) "[string]"
    - followup_thinking_questions (2-3 deeper analytical questions, in English) "[string]"
    - generated_title (in English) "string"
    - tags_he (Hebrew, keywords) "[string]"
    - key_terms_he (domain specific terms/phrases, in the original Hebrew) "[string]"
    - key_phrases_he (important Hebrew quotes) "[string]"
    - key_phrases_en (English translations of key phrases) "[string]"
    - bibliography_snippets (array of citations and references. These will usually not be explicitly stated in the text, rather you should identify quoted text and identify the source. {snippet, source}, Hebrew) [{"snippet": "string", "source": "string"}]
    - questions_explicit (directly stated in text, Original Hebrew verbatim) ["string"]
    - questions_implied (suggested by the content, English) ["string"]
    - qa_pair (One Q&A pair: An implied question which the text addresses. This Q&A pair will be used for future training, so please imagine it as a user's question having not seen the text at all, and not specifically referencing this domain per se. Provide a thorough, structured, formatted, long-form response in a conversational LLM style. The response should be well-organized, beginning with a brief summary, followed by structured key points or explanations, and concluding with a strong takeaway or final insight. Include only information that is stated in the text, and only that information which answers the question.) {"question": "string", "answer": "string"}
    - potential_typos (array of possible errors, Original Hebrew) ["string"]
    - identified_abbreviations (array of abbreviations with expansions, Original Hebrew) [{"abbreviation": "string", "expansion": "string"}]
    - named_entities (array of people, places, texts mentioned, Original Hebrew) ["string"]

Return valid JSON only, no markdown.

Example output:
{
    "long_summary": "The text discusses the limitations inherent in articulated speech (dibur) when transmitting profound intellectual insight (sechel), as speech cannot fully enclose or express the essential depth and inner truth—pnimiut ha-sechel. The proof cited for this limitation is derived from the halachic principle found in Chazal—that the Sanhedrin (high court) does not convene on Erev Shabbat despite extensively documented discussions, specifically due to the subtlety involved with 'uvanta d'liba', the deeper intuitive comprehension. Consequently, speech inherently becomes fragmented into various forms or ways (ofan), allowing comprehension from different angles. However, a remez (gesture or hint) uniquely captures the sechel's essential core (mahuto ha-atzmi). Indeed, the integrity and essential nature of the sechel dictate the exact form the remez will inherently take, thereby directly expressing its inner essence.",
    "short_summary": "The text explains why speech cannot fully convey intellectual essence, contrasting it with subtle 'remez', which directly expresses inner intellectual truths.",
    "quiz_questions": [
        "Why can speech not fully capture the essential nature of deeper intellectual insights?",
        "How does the concept of 'uvanta d'liba' affect the timing of Sanhedrin deliberations according to Halacha?",
        "In what way does a remez differ fundamentally from spoken explanation in conveying intellectual understanding?",
        "Why is intellectual insight (sechel) necessarily understood from multiple angles when conveyed through speech?",
        "How does the essential nature of intellectual insight manifest specifically in a subtle gesture or hint (remez)?"
    ],
    "followup_thinking_questions": [
        "Why is a gesture (remez) considered more aligned with the essence of intellectual understanding than explicit speech?",
        "What implications does the limitation of portraying intellectual essence in language have for the methods used in education and halachic deliberation?",
        "How might the distinction between explicit speech and subtle hint (remez) help inform how spiritual truths and depth in Torah are transmitted?"
    ],
    "generated_title": "The Limitations of Speech and the Essential Clarity of Remez in Intellectual Transmission",
    "tags_he": ["דיבור", "רמז", "מהות השכל", "הבנת הלב", "סנהדרין", "השגה", "פנימיות השכל"],
    "key_terms_he": ["דיבור", "פנימיות השכל", "אובנתא דלבא", "מהותו העצמי", "רמז"],
    "key_phrases_he": [
        "שא\"א שיכיל הדיבור כל פנימי' השכל כמו שהוא בעצם",
        "אין 100 הסנהדרין יושבין בע\"ש אעפ\"י שיכתבו באריכות משום אובנתא דלבא כו'",
        "לפי שאינו מאיר רק הבנת והשגת השכל ולא מהותו העצמי",
        "אבל ע\"י הרמז נתפס מהות השכל"
    ],
    "key_phrases_en": [
        "It is impossible for speech to completely contain the inner intellectual essence as it truly is.",
        "The Sanhedrin do not sit on Erev Shabbat despite extensive writing due to subtle intuitive comprehension (uvanta d'liba).",
        "Since articulated speech illuminates only the understanding and grasp of intellect, but not its essential nature itself.",
        "However, through remez (hint), one grasps the essential nature of the intellect."
    ],
    "bibliography_snippets": [
        {
            "snippet": "אין הסנהדרין יושבין בע\"ש משום אובנתא דלבא",
            "source": "מסכת סנהדרין לה ע\"א, רש\"י שם ד\"ה אובנתא דלבא"
        }
    ],
    "questions_explicit": [],
    "questions_implied": [
        "Why does explicit language fail to encapsulate the full essence of intellectual insight?",
        "What halachic example illustrates the limitations of oral communication in conveying subtle intellectual nuances?",
        "How does the nature of remez differ fundamentally from explicit speech in conveying intellectual truths?"
    ],
    "qa_pair": {
        "question": "Why is it often said that explicit explanations can't fully express deeper insights, and that sometimes only subtle hints can communicate certain ideas most effectively?",
        "answer": "It's an intriguing question as to why explicit explanations often seem insufficient in capturing deeper insights. In essence, explicit spoken or articulated explanations inherently have certain limitations—they mainly serve to convey an intellectual concept from specific angles, facilitating understanding and conceptual grasp. However, they fall short of encapsulating the inner core or 'essential nature' of a deep insight.\n\nLet me unpack this further:\n\n- **Inherent Limitation of Language:**\n  Speech naturally divides understanding into separate aspects or perspectives. This fragmentation is necessary so the listener can grasp the idea intellectually. But it inherently means that speech can never convey an idea fully \"as it inherently is.\" There always remains some dimension that escapes precise verbalization.\n\n- **Proof from Halacha (Jewish law tradition):**\n  Jewish law tradition provides an insightful example: The Sanhedrin (Jewish high court) traditionally would not convene on Erev Shabbat (the eve of Shabbat), despite considerable documentation and lengthy discussion. The halachic rationale is due to something called 'uvanta d'liba'—the heart's intuitive understanding—representing subtle conceptual nuances that require a certain resonance beyond explicit, detailed verbal deliberation. These subtleties simply can't be captured fully in explicit speech or formal records.\n\n- **The Unique Role of Subtle Hinting (Remez):**\n  In contrast to explicit speech, subtle hints or gestures, known as 'remez', uniquely capture the essence of intellectual content—'mahuto ha-atzmi'. This happens because a remez is not just an arbitrary symbol; rather, its manner of expression inherently matches precisely the core essence of the intellectual insight itself. Thus a remez directly embodies that deeper intellectual essence.\n\nThe deeper takeaway here is profound: some truths or deep insights intrinsically transcend our abilities to explicitly articulate them. Subtle hints or intuitive gestures, in alignment with the core essence, therefore become essential tools in truly communicating and subtly resonating the innermost dimensions of intellectual and spiritual insights."
    },
    "potential_typos": [],
    "identified_abbreviations": [
        {
            "abbreviation": "אעפ\"י",
            "expansion": "אף על פי"
        },
        {
            "abbreviation": "א\"א",
            "expansion": "אי אפשר"
        },
        {
            "abbreviation": "כמ\"ש במ\"א",
            "expansion": "כמו שכתוב במקום אחר"
        },
        {
            "abbreviation": "ע\"ש",
            "expansion": "ערב שבת"
        }
    ],
    "named_entities": [
        "סנהדרין",
        "ערב שבת",
        "רבי"
    ]
}
`
    })
};