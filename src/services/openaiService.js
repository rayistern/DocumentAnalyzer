')) {
            content = content.replace(/^```json\n/, '').replace(/\n```$/, '');
        } else if (content.includes('```')) {
            content = content.replace(/^```\n/, '').replace(/\n