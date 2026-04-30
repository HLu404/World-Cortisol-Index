# World Cortisol Index

A real-time global "stress map" — a 3D Earth where each country is colored by the sentiment of its current news headlines. Articles are pulled from **GDELT, GNews, NewsData,** and **NewsAPI**, scored with a positive/negative lexicon, and rendered on a rotating globe.

<img width="1889" height="893" alt="image" src="https://github.com/user-attachments/assets/a931d07f-37c4-4ca2-8222-da3dffaa0d97" />

## What the app does

- **Globe view** — a globe visualization of the world. Each article appears as a dot on its country and region.
- **Sentiment scoring** — every article is ran through a hugging face algorithm that determines the "cortisol" level and emotion of a headline. It rates it on a score of 0 (low cortisol) to 1 (high cortisol) and assigns a color green to red based on it.
- **Country averages** — clicking a country shows its average cortisol; clicking a dot opens an article and lets you visit its webpage.
- **Bar chart** — the sidebar shows the 20 highest cortisol countries.
- **Rolling archive** — articles persist in a "localStorage" so the map keeps content between visits.

