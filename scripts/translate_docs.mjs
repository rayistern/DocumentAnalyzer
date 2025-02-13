import OpenAI from 'openai';
import dotenv from 'dotenv';
import { glob } from 'glob';
import path from 'path';
import { supabase } from '../src/services/supabaseService.mjs';
import { spawn } from 'child_process';
import fs from 'fs/promises';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Define constant for model
const MODEL = "gpt-4o-mini";

async function convertAndTranslateFile(filepath, prompt) {
    try {
        const filename = path.basename(filepath);
        
        // Check if file already exists in translations
        const { data: existingTranslation } = await supabase
            .from('translations')
            .select('id')
            .eq('original_filename', filename)
            .limit(1);
            
        if (existingTranslation?.length > 0) {
            console.log(`Skipping ${filename} - already translated`);
            return;
        }

        // Create temp directory if it doesn't exist
        const tempDir = 'temp_convert';
        await fs.mkdir(tempDir, { recursive: true });
        
        // Convert doc to text
        const convertProcess = spawn('node', ['src/convert.mjs', filepath, '-o', tempDir]);
        
        // Capture error output
        convertProcess.stderr.on('data', (data) => {
            console.error(`Convert process error: ${data}`);
        });

        // Capture standard output for debugging
        convertProcess.stdout.on('data', (data) => {
            console.log(`Convert process output: ${data}`);
        });
        
        // Wait for conversion to complete
        await new Promise((resolve, reject) => {
            convertProcess.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`Convert process exited with code ${code}`));
            });
        });

        // Find and read the converted text file
        const txtFiles = await fs.readdir(tempDir);
        const txtFile = txtFiles.find(f => f.startsWith(path.basename(filepath, '.docx')));
        if (!txtFile) throw new Error('Converted text file not found');
        
        const tempOutputPath = path.join(tempDir, txtFile);
        const convertedText = await fs.readFile(tempOutputPath, 'utf-8');
        
        // Clean up temp file
        await fs.unlink(tempOutputPath);

        // Translate the text and get keywords
        const response = await openai.chat.completions.create({
            model: MODEL,
            messages: [{ 
                role: "user", 
                content: `${prompt}\n\nPlease provide: 1. Translation of the following text 2. A list of 5-10 tags/topics/keywords from the text, comma separated. Return as JSON with "translation" and "keywords" fields: ${convertedText}` 
            }],
        });

        console.log('\nAPI Response:', JSON.stringify(response, null, 2));
        
        let content = response.choices[0].message.content;
        // Simple cleanup of markdown
        content = content.replace(/```json\n/, '').replace(/```\n?$/, '');
        const result = JSON.parse(content);
        
        // Save to supabase with API stats and keywords
        await supabase.from('translations').insert({
            original_filename: filename,
            original_text: convertedText,
            translated_text: result.translation,
            keywords: result.keywords,
            timestamp: new Date().toISOString(),
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
            model: MODEL,
            prompt: prompt
        });
        
        console.log(`Processed ${filename}`);
    } catch (error) {
        console.error(`Error processing ${filepath}:`, error);
    }
}

async function processPattern(pattern, prompt) {
    try {
        const files = await glob(pattern);
        for (const filepath of files) {
            console.log(`Processing ${filepath}...`);
            await convertAndTranslateFile(filepath, prompt);
        }
    } catch (error) {
        console.error(`Error processing files:`, error);
        throw error; // Re-throw to show the full error
    }
}

// Main execution
const args = process.argv.slice(2);

if (args.length < 1) {
    console.log("Usage: node translate_docs.mjs -b <folder_pattern> [prompt] \n   or: node translate_docs.mjs <filepath> [prompt]");
    process.exit(1);
}

if (args[0] === "-b") {
    const pattern = args[1];
    const prompt = args[2] || "Translate this to English";
    await processPattern(pattern, prompt);
} else {
    const filepath = args[0];
    const prompt = args[1] || "Translate this to English";
    await convertAndTranslateFile(filepath, prompt);
}