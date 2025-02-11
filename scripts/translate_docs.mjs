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

async function translateText(text, prompt = "Translate this to English") {
    console.log('\nAPI Request:', {
        model: "o1-mini",
        messages: [{ role: "user", content: `${prompt}: ${text}` }]
    });

    const response = await openai.chat.completions.create({
        model: "o1-mini",
        messages: [{ role: "user", content: `${prompt}: ${text}` }],
    });

    console.log('\nAPI Response:', JSON.stringify(response, null, 2));
    return response.choices[0].message.content;
}

async function convertAndTranslateFile(filepath, prompt) {
    try {
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

        // Translate the text
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: `${prompt}: ${convertedText}` }],
        });

        console.log('\nAPI Response:', JSON.stringify(response, null, 2));
        
        // Save to supabase with API stats
        await supabase.from('translations').insert({
            original_filename: path.basename(filepath),
            original_text: convertedText,
            translated_text: response.choices[0].message.content,
            timestamp: new Date().toISOString(),
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
            model: response.model || "o1-mini",  // Fallback in case response.model is undefined
            prompt: prompt
        });
        
        console.log(`Processed ${filepath}`);
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
        console.error(`Error processing files: ${error}`);
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