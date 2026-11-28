async function fetchWithTimeout(url, options, timeoutMs = 4500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({
            error: 'GEMINI_API_KEY is not configured in Vercel Environment Variables.'
        });
    }

    try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
        let { imageBase64, mimeType } = body;

        if (!imageBase64 || typeof imageBase64 !== 'string') {
            return res.status(400).json({ error: 'Missing receipt image data.' });
        }

        // Strip data URL prefix if present (e.g. "data:image/jpeg;base64,...")
        const dataUrlMatch = imageBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (dataUrlMatch) {
            mimeType = mimeType || dataUrlMatch[1];
            imageBase64 = dataUrlMatch[2];
        }

        const safeMimeType = mimeType || 'image/jpeg';

        const categories = [
            'Groceries',
            'Dining',
            'Coffee & Snacks',
            'Fuel & Auto',
            'Clothing',
            'Shopping',
            'Home & Living',
            'Bills & Utilities',
            'Subscriptions',
            'Health & Fitness',
            'Personal Care',
            'Travel',
            'Entertainment',
            'Gifts',
            'Other'
        ];

        const prompt = [
            'Analyze this receipt image and extract the expense details.',
            'Rules:',
            '- merchant: Clean store, restaurant, or vendor name (e.g. "Costco", "Sheetz", "Target").',
            '- amount: Final total amount actually paid after tax and tip (use the final paid/charged total, not pre-tax subtotal) as a positive number.',
            '- date: Transaction date in YYYY-MM-DD format if clearly visible; otherwise empty string "".',
            '- category: Choose the single best matching category from the allowed enum list.',
            '- payment: Payment method if shown on receipt ("Apple Pay", "Google Pay", "Credit Card", "Debit Card", "Cash", "Gift Card"), otherwise empty string "".',
            '- note: Short, helpful summary of 1 to 3 key items purchased (under 60 characters), or empty string "" if unreadable.'
        ].join('\n');

        const requestPayload = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        {
                            inlineData: {
                                mimeType: safeMimeType,
                                data: imageBase64
                            }
                        }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'OBJECT',
                    properties: {
                        merchant: { type: 'STRING' },
                        amount: { type: 'NUMBER' },
                        date: { type: 'STRING' },
                        category: {
                            type: 'STRING',
                            enum: categories
                        },
                        payment: { type: 'STRING' },
                        note: { type: 'STRING' }
                    },
                    required: ['merchant', 'amount', 'date', 'category', 'payment', 'note']
                }
            }
        };

        // Route across rolling aliases and separate model pools to bypass traffic spikes
        const modelsToTry = [
            'gemini-flash-lite-latest',
            'gemini-flash-latest',
            'gemini-3.8-flash',
            'gemini-3.8-pro'
        ];

        let textOutput = '';
        let lastError = 'Gemini API request failed.';
        let lastStatus = 502;

        for (let i = 0; i < modelsToTry.length; i++) {
            const model = modelsToTry[i];
            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

            try {
                const geminiResponse = await fetchWithTimeout(
                    geminiUrl,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-goog-api-key': apiKey
                        },
                        body: JSON.stringify(requestPayload)
                    },
                    4500
                );

                const rawResult = await geminiResponse.json();

                if (geminiResponse.ok) {
                    textOutput = rawResult?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    if (textOutput) break;
                    lastError = `Empty response from ${model}.`;
                    lastStatus = 502;
                    continue;
                }

                lastStatus = geminiResponse.status;
                lastError = `[${model}] ${rawResult?.error?.message || `HTTP ${geminiResponse.status}`}`;

                // If 404/400, jump immediately to next model; if 429/503, pause 700ms first
                if ([400, 404, 429, 503].includes(geminiResponse.status) && i < modelsToTry.length - 1) {
                    if ([429, 503].includes(geminiResponse.status)) {
                        await new Promise(resolve => setTimeout(resolve, 700));
                    }
                    continue;
                }

                return res.status(lastStatus).json({ error: lastError });
            } catch (fetchErr) {
                lastStatus = 504;
                lastError = `[${model}] Request timed out`;
                if (i < modelsToTry.length - 1) continue;
                return res.status(lastStatus).json({ error: lastError });
            }
        }

        if (!textOutput) {
            return res.status(lastStatus).json({ error: lastError });
        }

        const cleanJson = textOutput.replace(/^```json\s*|\s*```$/g, '').trim();
        const extracted = JSON.parse(cleanJson);

        return res.status(200).json({
            merchant: String(extracted.merchant || '').trim(),
            amount: Number(extracted.amount) || 0,
            date: String(extracted.date || '').trim(),
            category: categories.includes(extracted.category) ? extracted.category : 'Other',
            payment: String(extracted.payment || '').trim(),
            note: String(extracted.note || '').trim()
        });
    } catch (err) {
        console.error('Receipt scan failed:', err);
        return res.status(500).json({
            error: err.message || 'Unexpected error scanning receipt.'
        });
    }
};
