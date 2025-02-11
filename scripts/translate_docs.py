import openai
from supabase import create_client
from datetime import datetime
import os
from dotenv import load_dotenv
import glob
import subprocess

load_dotenv()

# Init clients
openai.api_key = os.getenv("OPENAI_API_KEY")
supabase = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_KEY"))

def translate_text(text, prompt="Translate this to English"):
    response = openai.chat.completions.create(
        model="o3-mini",
        messages=[{"role": "user", "content": f"{prompt}: {text}"}],
        temperature=0
    )
    return response.choices[0].message.content

def process_file(filepath, prompt="Translate this to English"):
    filename = os.path.basename(filepath)
    
    with open(filepath, 'r', encoding='utf-8') as f:
        text = f.read()
    
    translation = translate_text(text, prompt)
    
    supabase.table('translations').insert({
        'original_filename': filename,
        'original_text': text,
        'translated_text': translation,
        'timestamp': datetime.utcnow().isoformat()
    }).execute()

def convert_and_process(pattern, prompt):
    # First convert docs to txt
    try:
        subprocess.run(['node', 'src/convert.mjs', pattern, '-o', 'converted'], check=True)
    except subprocess.CalledProcessError as e:
        print(f"Error converting files: {e}")
        return

    # Then process all converted txt files
    txt_files = glob.glob('converted/*.txt')
    for filepath in txt_files:
        print(f"Processing {filepath}...")
        process_file(filepath, prompt)

# Usage example:
# process_file('path/to/your/text_file.txt') 

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python translate_docs.py -b <folder_pattern> [prompt] \n   or: python translate_docs.py <filepath> [prompt]")
        sys.exit(1)
    
    if sys.argv[1] == "-b":
        pattern = sys.argv[2]
        prompt = sys.argv[3] if len(sys.argv) > 3 else "Translate this to English"
        convert_and_process(pattern, prompt)
    else:
        filepath = sys.argv[1]
        prompt = sys.argv[2] if len(sys.argv) > 2 else "Translate this to English"
        process_file(filepath, prompt) 