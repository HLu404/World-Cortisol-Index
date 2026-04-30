const { fetchWithTimeout, extractDomain, dedupeByUrl } = require('./_helpers');

async function fetchMediastackNews(query = 'world') {
    try {
        const url = `http://api.mediastack.com/v1/news?access_key=${process.env.MEDIASTACK_API_KEY}&keywords=${encodeURIComponent(query)}&languages=en`;
        const response = await fetchWithTimeout(url);
        
        if (!response.ok) throw new Error("API Request Failed");

        const data = await response.json();
        
        const articles = (data.data || []).map(article => {
            const u = (article.url || '').trim();
            return {
                title: article.title || '',
                url: u,
                domain: extractDomain(u) || article.source,
                sourcecountry: '', 
                seendate: article.published_at || '',
                _api: 'mediastack'
            };
        });
        
        const deduped = dedupeByUrl(articles);
        console.log(`[Mediastack] articles retrieved: ${deduped.length}`);
        return deduped;
        
    } catch (error) {
        console.log('[Mediastack] articles retrieved: 0');
        return []; 
    }
}

module.exports = { fetchMediastackNews };