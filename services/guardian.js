const { fetchWithTimeout, extractDomain, dedupeByUrl } = require('./_helpers');

async function fetchGuardianNews(query = 'world') {
    try {
        const url = `https://content.guardianapis.com/search?q=${encodeURIComponent(query)}&api-key=${process.env.GUARDIAN_API_KEY}`;
        const response = await fetchWithTimeout(url);
        
        if (!response.ok) throw new Error("API Request Failed");

        const data = await response.json();
        
        const articles = (data.response?.results || []).map(article => {
            const u = (article.webUrl || '').trim();
            return {
                title: article.webTitle || '',
                url: u,
                domain: extractDomain(u) || 'theguardian.com',
                sourcecountry: 'uk', 
                seendate: article.webPublicationDate || '',
                _api: 'guardian'
            };
        });
        
        const deduped = dedupeByUrl(articles);
        console.log(`[Guardian] articles retrieved: ${deduped.length}`);
        return deduped;
        
    } catch (error) {
        console.log('[Guardian] articles retrieved: 0');
        return [];
    }
}

module.exports = { fetchGuardianNews };