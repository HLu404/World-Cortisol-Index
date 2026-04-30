# World Cortisol Index

A real-time global "stress map" — a 3D Earth where each country is colored by the sentiment of its current news headlines. Articles are pulled from **GDELT, GNews, NewsData,** and **NewsAPI**, scored with a positive/negative lexicon, and rendered on a rotating globe.

<img width="1913" height="838" alt="image" src="https://github.com/user-attachments/assets/c1d0debc-1b6e-43f4-be18-e43376e13659" />

The world today is filled with disinformation, doomposting, and gloom. But how bad can it be? The World Cortisol Index allows you to take a look at the world, one article at a time, and see which countries are experiencing turmoil, political unrest, and general high cortisol. The index provides a brief look at the world today, giving users the opportunity to see for themselves how bad things are getting. Will WW3 begin? Is Canada on fire today? fnid out with the World Cortisol Index.

<img width="1911" height="908" alt="image" src="https://github.com/user-attachments/assets/14007145-c2f1-4727-82a1-de44f14a790c" />

## What the app does

- **Globe view** — a globe visualization of the world. Each article appears as a dot on its country and region.
- **Sentiment scoring** — every article is ran through a hugging face algorithm that determines the "cortisol" level and emotion of a headline. It rates it on a score of 0 (low cortisol) to 1 (high cortisol) and assigns a color green to red based on it.
- **Country averages** — clicking a country shows its average cortisol; clicking a dot opens an article and lets you visit its webpage.
- **Bar chart** — the sidebar shows the 20 highest cortisol countries.
- **Rolling archive** — articles persist in a "localStorage" so the map keeps content between visits.
- **Updates** - users can refresh articles to see whats new on the world today.
- **The Cortisol in Brief** - users can explore daily articles of what's going on today, provided with brief summaries powered by AI, and a chatbot to ask questions about articles read.

<img width="1912" height="888" alt="image" src="https://github.com/user-attachments/assets/274e592e-4466-4bc1-b51b-8ba91547c718" />


## Technologies

**Backend:** Node.js, JavaScript, Axios, Native Fetch API, Dotenv, Hugging Face 

**External APIs:** GDELT Project , NewsAPI, GNews, NewsData.io, The Guardian API, Mediastack

**Frontend:** HTML, CSS, Javascript

## Team

Harry Lu, Andy Li
