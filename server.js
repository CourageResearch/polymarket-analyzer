const express = require('express');
const cors = require('cors');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk').default;
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic();

const GAMMA_API = 'https://gamma-api.polymarket.com';

// Fetch events by tag (finance = need to find tag_id)
app.get('/api/events', async (req, res) => {
  try {
    const { tag, limit = 50, offset = 0 } = req.query;

    let url = `${GAMMA_API}/events?order=id&ascending=false&closed=false&limit=${limit}&offset=${offset}`;

    if (tag) {
      // First get tags to find the ID
      const tagsResponse = await axios.get(`${GAMMA_API}/tags`);
      const tagObj = tagsResponse.data.find(t =>
        t.label?.toLowerCase().includes(tag.toLowerCase()) ||
        t.slug?.toLowerCase().includes(tag.toLowerCase())
      );
      if (tagObj) {
        url += `&tag_id=${tagObj.id}`;
      }
    }

    const response = await axios.get(url);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching events:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Fetch all available tags
app.get('/api/tags', async (req, res) => {
  try {
    const response = await axios.get(`${GAMMA_API}/tags`);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching tags:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Fetch specific event by slug
app.get('/api/event/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const response = await axios.get(`${GAMMA_API}/events/slug/${slug}`);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching event:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Fetch markets for analysis
app.get('/api/markets', async (req, res) => {
  try {
    const { limit = 100, offset = 0, tag_id } = req.query;
    let url = `${GAMMA_API}/markets?closed=false&limit=${limit}&offset=${offset}`;
    if (tag_id) {
      url += `&tag_id=${tag_id}`;
    }
    const response = await axios.get(url);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching markets:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// AI Analysis endpoint - analyze a single market/event
app.post('/api/analyze', async (req, res) => {
  try {
    const { event } = req.body;

    if (!event) {
      return res.status(400).json({ error: 'Event data required' });
    }

    // Build context about the market
    const marketContext = buildMarketContext(event);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: `You are an expert market analyst evaluating prediction market odds. Today's date is ${new Date().toISOString().split('T')[0]}. Analyze this Polymarket event and determine if the current odds seem mispriced.

${marketContext}

IMPORTANT: Look at the end date carefully - this market may resolve very soon (within weeks/days). Consider:
- Current market caps of the companies involved
- Recent stock price movements and trends
- How much the market cap would need to change in the remaining time
- Whether such a change is realistic given current momentum

Please provide:
1. **Current Reality Check**: What are the actual current market caps? Who is #1 right now?
2. **Your Fair Probability Estimate**: What do you think the true probability should be for each outcome?
3. **Discrepancy Analysis**: Compare your estimates to the current market prices. Flag any that look wrong.
4. **Verdict**: MISPRICED / FAIR / UNCERTAIN
5. **If mispriced**: Which bet looks attractive and why?

Be direct and specific with numbers. No fluff.`
        }
      ]
    });

    res.json({
      analysis: message.content[0].text,
      event: event.title || event.question,
      markets: event.markets?.map(m => ({
        question: m.question,
        outcomePrices: m.outcomePrices,
        outcomes: m.outcomes
      }))
    });
  } catch (error) {
    console.error('Error analyzing market:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Batch analysis - scan multiple markets and find mispriced ones
app.post('/api/scan', async (req, res) => {
  try {
    const { events } = req.body;

    if (!events || !events.length) {
      return res.status(400).json({ error: 'Events array required' });
    }

    // Build summary of all markets for efficient scanning
    const marketsSummary = events.map(event => {
      const markets = event.markets || [];
      return {
        id: event.id,
        title: event.title,
        slug: event.slug,
        markets: markets.map(m => ({
          question: m.question,
          outcomes: m.outcomes,
          outcomePrices: m.outcomePrices,
          volume: m.volume,
          liquidity: m.liquidity
        }))
      };
    }).filter(e => e.markets.length > 0);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: `You are an expert market analyst scanning prediction markets for mispriced odds. Review these Polymarket events and identify any that appear significantly mispriced (>30% discrepancy between market odds and your fair value estimate).

MARKETS TO SCAN:
${JSON.stringify(marketsSummary, null, 2)}

For each market, the outcomePrices array contains the current price for each outcome (0-1 scale, representing probability).

RESPOND IN THIS JSON FORMAT ONLY:
{
  "mispriced": [
    {
      "eventId": "id",
      "eventTitle": "title",
      "slug": "slug",
      "marketQuestion": "specific market question",
      "currentOdds": "e.g., Yes: 75%, No: 25%",
      "fairOdds": "e.g., Yes: 40%, No: 60%",
      "discrepancy": "percentage difference",
      "reasoning": "brief explanation",
      "confidence": "High/Medium/Low",
      "recommendation": "BUY YES / BUY NO / etc"
    }
  ],
  "summary": "brief overall summary of findings"
}

Only include markets where you have HIGH confidence in a >30% mispricing. Be selective and rigorous.`
        }
      ]
    });

    // Parse the response
    let result;
    try {
      const text = message.content[0].text;
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        result = { mispriced: [], summary: text };
      }
    } catch (parseError) {
      result = { mispriced: [], summary: message.content[0].text };
    }

    res.json(result);
  } catch (error) {
    console.error('Error scanning markets:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Helper to parse stringified arrays from API
function parseArrayField(field) {
  if (Array.isArray(field)) return field;
  if (typeof field === 'string') {
    try {
      return JSON.parse(field);
    } catch {
      return [];
    }
  }
  return [];
}

function buildMarketContext(event) {
  let context = `EVENT: ${event.title || 'Unknown'}\n`;
  context += `DESCRIPTION: ${event.description || 'No description'}\n`;
  context += `END DATE: ${event.endDate || 'Unknown'}\n\n`;

  if (event.markets && event.markets.length > 0) {
    context += 'MARKETS:\n';
    event.markets.forEach((market, i) => {
      context += `\n--- Market ${i + 1} ---\n`;
      context += `Question: ${market.question || market.groupItemTitle || 'Unknown'}\n`;

      const outcomes = parseArrayField(market.outcomes);
      const outcomePrices = parseArrayField(market.outcomePrices);

      if (outcomes.length > 0 && outcomePrices.length > 0) {
        context += 'Current Prices:\n';
        outcomes.forEach((outcome, j) => {
          const price = outcomePrices[j];
          const percentage = (parseFloat(price) * 100).toFixed(1);
          context += `  - ${outcome}: ${percentage}%\n`;
        });
      }

      if (market.volume) {
        context += `Volume: $${parseFloat(market.volume).toLocaleString()}\n`;
      }
      if (market.liquidity) {
        context += `Liquidity: $${parseFloat(market.liquidity).toLocaleString()}\n`;
      }
    });
  }

  return context;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
