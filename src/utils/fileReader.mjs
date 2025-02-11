import fs from 'fs/promises';
import path from 'path';
import { convertToText } from './documentConverter.mjs';

export async function readTextFile(filepath) {
    try {
        const absolutePath = path.resolve(filepath);
        const ext = path.extname(filepath).toLowerCase();
        
        let content;
        if (ext === '.docx' || ext === '.doc') {
            content = await convertToText(absolutePath);
        } else {
            content = await fs.readFile(absolutePath, 'utf8');
        }
        
        if (!content.trim()) {
            throw new Error('File is empty');
        }
        
        return content;
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`File not found: ${filepath}`);
        }
        throw new Error(`Error reading file: ${error.message}`);
    }
}
